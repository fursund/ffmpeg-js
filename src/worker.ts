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
    
    // Set up progress callback
    // Helper to validate progress values - reject obviously invalid values
    const isValidProgress = (value) => {
      if (typeof value !== 'number' || !isFinite(value)) return false;
      // If it's a percentage (0-1), it should be in that range
      if (value >= 0 && value <= 1) return true;
      // If it's a frame number, it should be reasonable (not billions)
      // Frame numbers typically don't exceed 10 million for reasonable videos
      if (value > 0 && value < 10000000) return true;
      return false;
    };
    
    const progressCallback = (progressObj) => {
      // Validate progress values before sending to main thread
      // The FFmpeg core sometimes sends invalid/uninitialized values
      let validProgress = null;
      
      if (typeof progressObj === 'number') {
        if (isValidProgress(progressObj)) {
          validProgress = progressObj;
        } else {
          return;
        }
      } else if (progressObj && typeof progressObj.progress === 'number') {
        if (isValidProgress(progressObj.progress)) {
          validProgress = progressObj.progress;
        } else {
          return;
        }
      } else if (progressObj && typeof progressObj.time === 'number') {
        // Validate time value - should be reasonable (not MAX_SAFE_INTEGER or negative huge values)
        if (isFinite(progressObj.time) && progressObj.time >= 0 && progressObj.time < 86400 * 365) {
          // Time-only progress is valid, but we can't determine percentage
          // Still forward it, but main thread will handle it appropriately
          validProgress = progressObj;
        } else {
          return;
        }
      }
      
      // Only send if we have valid progress data
      if (validProgress !== null) {
        self.postMessage({
          type: 'progress',
          payload: typeof validProgress === 'number' ? validProgress : progressObj,
        });
      }
    };
    
    if (typeof core.setProgress === 'function') {
      core.setProgress(progressCallback);
    } else if (core.progress !== undefined) {
      core.progress = progressCallback;
    }
    
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
            const originalLogger = core.logger;
            const originalProgress = core.progress;
            
            // Wrap logger to detect aborts
            const wrappedLogger = (logObj) => {
              if (originalLogger) {
                originalLogger(logObj);
              }
              const message = logObj?.message || String(logObj || '');
              if (message && message.trim() === 'Aborted()') {
                aborted = true;
              }
            };
            
            // Wrap progress callback to track if we reached 100%
            const wrappedProgress = (progressObj) => {
              if (originalProgress) {
                originalProgress(progressObj);
              }
              // Check if progress reached 100%
              if (typeof progressObj === 'number') {
                if (progressObj >= 1.0) {
                  progressReached100 = true;
                }
              } else if (progressObj && typeof progressObj.progress === 'number') {
                if (progressObj.progress >= 1.0) {
                  progressReached100 = true;
                }
              }
            };
            
            // Temporarily replace logger and progress to detect aborts and completion
            core.logger = wrappedLogger;
            core.progress = wrappedProgress;
            
            // Ensure -loglevel is set to 'info' to see frame progress messages
            // FFmpeg by default might not output verbose logs during encoding
            let execArgs = [...payload.args];
            const hasLogLevel = execArgs.some((arg, idx) => 
              arg === '-loglevel' || arg === '-v' || 
              (idx > 0 && (execArgs[idx - 1] === '-loglevel' || execArgs[idx - 1] === '-v'))
            );
            if (!hasLogLevel) {
              // Insert -loglevel info after the input file (usually after -i)
              // This ensures we see frame progress messages during encoding
              const inputIndex = execArgs.findIndex(arg => arg === '-i');
              if (inputIndex >= 0 && inputIndex < execArgs.length - 1) {
                execArgs.splice(inputIndex + 2, 0, '-loglevel', 'info');
              } else {
                // If no -i found, prepend to args
                execArgs.unshift('-loglevel', 'info');
              }
            }
            
            // Handle timeout (if provided)
            const timeout = payload.timeout !== undefined ? payload.timeout : -1;
            if (typeof core.setTimeout === 'function') {
              core.setTimeout(timeout);
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

