/**
 * Worker script for FFmpeg execution
 * This script runs in a Web Worker and handles all FFmpeg operations
 */

export const workerScript = `
  let core = null;
  
  // Helper to load script - handle both blob URLs and regular URLs
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      try {
        importScripts(url);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }
  
  async function loadCore(config) {
    try {
      // Load the core script first
      // Try importScripts first (for classic workers)
      try {
        await loadScript(config.coreURL);
      } catch (error) {
        // If importScripts fails, try dynamic import (for module workers)
        // Note: Dynamic import in workers may not work in all environments
        // If this fails, we'll rely on the original error
        throw error;
      }
      
      // Verify createFFmpegCore is available
      if (typeof createFFmpegCore === 'undefined') {
        throw new Error('createFFmpegCore is not defined after loading core script');
      }
    } catch (error) {
      throw error;
    }
    
    // Determine wasmURL
    // If not provided, derive from coreURL (as per official implementation)
    const coreURL = config.coreURL;
    const wasmURL = config.wasmURL || coreURL.replace(/.js$/g, '.wasm');
    
    // Encode wasmURL in mainScriptUrlOrBlob (as per official implementation)
    // This is a hack to fix locateFile issue with ffmpeg-core
    const urlConfig = {
      wasmURL: wasmURL,
    };
    const encodedConfig = btoa(JSON.stringify(urlConfig));
    const mainScriptUrlOrBlob = coreURL + '#' + encodedConfig;
    
    // Create the core - only pass mainScriptUrlOrBlob (as per official implementation)
    core = await createFFmpegCore({
      mainScriptUrlOrBlob,
    });
    
    // Wait for core to be ready
    if (core.ready && typeof core.ready.then === 'function') {
      await core.ready;
    }
    
    // Set up logger callback
    const loggerCallback = (logObj) => {
      const message = logObj?.message || String(logObj || '');
      if (message && message.trim()) {
        // Always forward log messages to main thread
        self.postMessage({
          type: 'log',
          payload: { type: logObj.type || 'stdout', message },
        });
      }
    };
    
    if (typeof core.setLogger === 'function') {
      core.setLogger(loggerCallback);
    } else if (core.logger !== undefined) {
      core.logger = loggerCallback;
    }
    
    // Don't set up global progress callback - we only use out_time_ms from logs
    // This ensures progress is only sent from logger parsing, not from core callbacks
    
    return core;
  }
  
  let currentExecId = null;
  let shouldTerminate = false;
  
  self.onmessage = async (event) => {
    const { id, type, payload } = event.data;
    
    try {
      switch (type) {
        case 'load': {
          await loadCore(payload);
          self.postMessage({
            id,
            type: 'load',
            success: true,
            payload: { ready: true },
          });
          break;
        }
        
        case 'terminate': {
          if (currentExecId && currentExecId === payload.execId) {
            shouldTerminate = true;
            // Try to abort the core if available
            if (core && typeof core.abort === 'function') {
              try {
                core.abort();
              } catch (e) {
                // Ignore errors from abort
              }
            }
            self.postMessage({
              id,
              type: 'terminate',
              success: true,
            });
          } else {
            self.postMessage({
              id,
              type: 'terminate',
              success: false,
              error: 'No matching execution found to terminate',
            });
          }
          break;
        }
        
        case 'exec': {
          if (!core) {
            throw new Error('Core not loaded');
          }
          
          // Set current exec ID and reset termination flag
          currentExecId = payload.id || id;
          shouldTerminate = false;
          
          try {
            // Track if we see "Aborted()" message and progress
            let aborted = false;
            let progressReached100 = false;
            let knownDurationSec = null;
            let lastSize = 0; // Track last size to accumulate
            let lastFrame = 0; // Track last frame number
            const originalLogger = core.logger;
            const originalProgress = core.progress;
            
            // Wrap logger to detect aborts and parse progress from logs
            const wrappedLogger = (logObj) => {
              if (originalLogger) {
                originalLogger(logObj);
              }
              const message = (logObj?.message || String(logObj || '')).trim();
              if (message === 'Aborted()') {
                aborted = true;
              }
              // Parse duration once at the very beginning from ffmpeg banner
              // This gives us totalDuration for calculating progress ratio
              if (knownDurationSec === null && message.includes('Duration')) {
                // Parse duration using regex - use RegExp constructor with double-escaped backslashes
                // In template string, need \\\\ to get \\ in the string, which becomes \ in the regex
                const pattern = 'Duration:\\\\s*(\\\\d{2}):(\\\\d{2}):(\\\\d{2})\\\\.(\\\\d+)';
                const durationRegex = new RegExp(pattern);
                const durationMatch = message.match(durationRegex);
                
                if (durationMatch) {
                  const h = parseInt(durationMatch[1], 10);
                  const mi = parseInt(durationMatch[2], 10);
                  const s = parseInt(durationMatch[3], 10);
                  const frac = durationMatch[4];
                  const fracSec = frac.length === 6 
                    ? parseInt(frac, 10) / 1000000
                    : parseInt(frac, 10) / 100;
                  knownDurationSec = h * 3600 + mi * 60 + s + fracSec;
                  self.postMessage({
                    type: 'log',
                    payload: { type: 'debug', message: 'DEBUG: Parsed totalDuration=' + knownDurationSec.toFixed(6) + 's (h=' + h + ', m=' + mi + ', s=' + s + ', frac=' + frac + ')' }
                  });
                }
              }
              
              // Parse progress from log messages using out_time_ms, total_size, and frame
              // -progress pipe:1 outputs key=value pairs, one per line
              // Format: "out_time_ms=4914000", "total_size=48", and "frame=78"
              if (knownDurationSec !== null && knownDurationSec > 0) {
                // Parse out_time_ms
                const timeMsRegex = new RegExp('out_time_ms\\\\s*=\\\\s*(\\\\d+)', 'i');
                const timeMsMatch = message.match(timeMsRegex);
                
                // Parse total_size (in bytes)
                const sizeRegex = new RegExp('total_size\\\\s*=\\\\s*(\\\\d+)', 'i');
                const sizeMatch = message.match(sizeRegex);
                
                // Parse frame number
                const frameRegex = new RegExp('frame\\\\s*=\\\\s*(\\\\d+)', 'i');
                const frameMatch = message.match(frameRegex);
                
                if (timeMsMatch) {
                  // out_time_ms is in microseconds, not milliseconds! Divide by 1,000,000
                  const currentTimeSec = parseInt(timeMsMatch[1], 10) / 1000000;
                  if (currentTimeSec >= 0 && isFinite(currentTimeSec)) {
                    // Calculate ratio - allow it to go to 1.0 naturally
                    const ratio = Math.max(0, Math.min(1, currentTimeSec / knownDurationSec));
                    
                    // Get size if available
                    let size = null;
                    if (sizeMatch) {
                      size = parseInt(sizeMatch[1], 10);
                      lastSize = size; // Update last known size
                    } else if (lastSize > 0) {
                      size = lastSize; // Use last known size if not in this message
                    }
                    
                    // Get frame if available
                    let frame = null;
                    if (frameMatch) {
                      frame = parseInt(frameMatch[1], 10);
                      lastFrame = frame; // Update last known frame
                    } else if (lastFrame > 0) {
                      frame = lastFrame; // Use last known frame if not in this message
                    }
                    
                    // Send progress with size and frame information
                    const progressPayload = (size !== null || frame !== null)
                      ? { progress: ratio, ...(size !== null && { size: size }), ...(frame !== null && { frame: frame }) }
                      : ratio;
                    
                    // Debug: log progress calculation
                    self.postMessage({
                      type: 'log',
                      payload: { type: 'debug', message: 'DEBUG: Progress: out_time_ms=' + timeMsMatch[1] + ' (microseconds), currentTimeSec=' + currentTimeSec.toFixed(3) + ', duration=' + knownDurationSec.toFixed(3) + ', ratio=' + ratio.toFixed(4) + (size !== null ? ', size=' + size + ' bytes' : '') + (frame !== null ? ', frame=' + frame : '') }
                    });
                    self.postMessage({ 
                      type: 'progress', 
                      payload: progressPayload 
                    });
                  }
                } else if (sizeMatch) {
                  // Size update without time - just update lastSize for next time
                  lastSize = parseInt(sizeMatch[1], 10);
                } else if (frameMatch) {
                  // Frame update without time - just update lastFrame for next time
                  lastFrame = parseInt(frameMatch[1], 10);
                }
              } else if (message.includes('out_time_ms')) {
                // Debug: out_time_ms found but duration not known yet
                self.postMessage({
                  type: 'log',
                  payload: { type: 'debug', message: 'DEBUG: out_time_ms found but duration unknown (knownDurationSec=' + knownDurationSec + ')' }
                });
              }
            };
            
            // Wrap progress callback to track if we reached 100%
            // Note: We don't send progress from here - we use out_time_ms from logs instead
            const wrappedProgress = (progressObj) => {
              if (originalProgress) {
                originalProgress(progressObj);
              }
              
              // Check if progress reached 100% for completion tracking
              if (typeof progressObj === 'number') {
                if (progressObj >= 1.0) {
                  progressReached100 = true;
                }
              } else if (progressObj && typeof progressObj.progress === 'number') {
                if (progressObj.progress >= 1.0) {
                  progressReached100 = true;
                }
              }
              
              // Don't send progress from here - we use out_time_ms parsing from logs instead
              // This ensures consistent progress calculation based on time/duration
            };
            
            // Temporarily replace logger and progress to detect aborts and completion
            core.logger = wrappedLogger;
            core.progress = wrappedProgress;
            
            // Ensure -loglevel is set to 'info' to see logs
            // Also ensure -progress pipe:1 to emit time updates we can parse
            let execArgs = [...payload.args];
            const hasLogLevel = execArgs.some((arg, idx) => 
              arg === '-loglevel' || arg === '-v' || 
              (idx > 0 && (execArgs[idx - 1] === '-loglevel' || execArgs[idx - 1] === '-v'))
            );
            if (!hasLogLevel) {
              // Insert -loglevel info after the input file (usually after -i)
              // This ensures we see informational logs
              const inputIndex = execArgs.findIndex(arg => arg === '-i');
              if (inputIndex >= 0 && inputIndex < execArgs.length - 1) {
                execArgs.splice(inputIndex + 2, 0, '-loglevel', 'info');
              } else {
                // If no -i found, prepend to args
                execArgs.unshift('-loglevel', 'info');
              }
            }

            // Add -progress pipe:1 if not provided so ffmpeg emits out_time(_ms) lines
            const hasProgress = execArgs.some((arg, idx) => 
              arg === '-progress' || (idx > 0 && execArgs[idx - 1] === '-progress')
            );
            if (!hasProgress) {
              execArgs.push('-progress', 'pipe:1');
            }
            
            // Execute the command - in 0.12, exec() is synchronous and blocks until completion
            // It returns the ret value directly when done
            core.exec(...execArgs);
            
            // Check if termination was requested
            if (shouldTerminate && currentExecId === (payload.id || id)) {
              shouldTerminate = false;
              currentExecId = null;
              // Restore original logger and progress
              core.logger = originalLogger;
              core.progress = originalProgress;
              
              // Reset the core state
              if (typeof core.reset === 'function') {
                core.reset();
              }
              
              // Send termination response
              self.postMessage({
                id,
                type: 'exec',
                success: false,
                payload: { ret: -1 },
                error: 'FFmpeg execution was terminated',
              });
              return;
            }
            
            // Restore original logger and progress
            core.logger = originalLogger;
            core.progress = originalProgress;
            
            // Clear current exec ID
            currentExecId = null;
            
            // Get the return value from core.ret
            const ret = (core.ret !== undefined) ? core.ret : -1;
            
            // Reset the core state (as per official implementation)
            if (typeof core.reset === 'function') {
              core.reset();
            }
            
            // If we saw "Aborted()" but progress reached 100%, that's OK (normal shutdown)
            // Otherwise, abort is a failure
            const abortedButComplete = aborted && progressReached100;
            const success = (ret === 0) || abortedButComplete;
            
            // Send response
            self.postMessage({
              id,
              type: 'exec',
              success,
              payload: { ret: abortedButComplete ? 0 : ret },
              error: !success ? (aborted && !progressReached100 ? 'FFmpeg execution was aborted before completion' : 'Execution failed with exit code ' + ret) : undefined,
            });
          } catch (error) {
            // Clear current exec ID on error
            currentExecId = null;
            shouldTerminate = false;
            
            // Handle execution errors
            const errorMsg = error && error.message ? error.message : String(error);
            self.postMessage({
              id,
              type: 'exec',
              success: false,
              payload: { ret: -1 },
              error: errorMsg,
            });
          }
          break;
        }
        
        case 'writeFile': {
          if (!core) {
            throw new Error('Core not loaded');
          }
          const { path, data } = payload;
          core.FS.writeFile(path, new Uint8Array(data));
          self.postMessage({
            id,
            type: 'writeFile',
            success: true,
          });
          break;
        }
        
        case 'readFile': {
          if (!core) {
            throw new Error('Core not loaded');
          }
          const { path } = payload;
          const data = core.FS.readFile(path);
          // Convert to array for transfer
          self.postMessage({
            id,
            type: 'readFile',
            success: true,
            payload: { data: Array.from(data) },
          });
          break;
        }
        
        case 'deleteFile': {
          if (!core) {
            throw new Error('Core not loaded');
          }
          const { path } = payload;
          try {
            core.FS.unlink(path);
            self.postMessage({
              id,
              type: 'deleteFile',
              success: true,
            });
          } catch (error) {
            self.postMessage({
              id,
              type: 'deleteFile',
              success: false,
              error: error?.message || String(error),
            });
          }
          break;
        }
        
        default:
          self.postMessage({
            id,
            type: 'error',
            success: false,
            error: 'Unknown message type: ' + type,
          });
      }
    } catch (error) {
      self.postMessage({
        id,
        type,
        success: false,
        error: error?.message || String(error),
      });
    }
  };
`;

