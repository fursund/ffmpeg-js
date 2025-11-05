import { noop, toBlobURL, toUint8Array } from './utils';
import * as types from './types';

export class FFmpegBase {
  private _worker: Worker | null = null;

  private _logger = noop;
  private _source: string;

  private _uris?: types.WasmModuleURIs;

  private _whenReady: Array<types.EventCallback> = [];
  private _whenExecutionDone: Array<types.EventCallback> = [];

  private _onMessage: Array<types.MessageCallback> = [];
  private _onProgress: Array<types.ProgressCallback> = [];

  private _memory: string[] = [];
  private _pendingMessages: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map();
  private _messageIdCounter = 0;

  /**
   * Is true when the script has been
   * loaded successfully
   */
  public isReady: boolean = false;

  public constructor({ logger, source }: types.FFmpegBaseSettings) {
    this._source = source;
    this._logger = logger;
    this.createWorker();
  }

  /**
   * Handles the ffmpeg logs
   */
  private handleMessage(msg: string) {
    // Use the configured logger
    this._logger(msg);

    if (msg.match(/(FFMPEG_END|error)/i)) {
      this._whenExecutionDone.forEach((cb) => cb());
    }
    // Parse frame progress from messages as fallback
    // The core progress callback should handle this, but we keep this for backwards compatibility
    const frameMatch = msg.match(/frame=\s*(\d+)/);
    if (frameMatch) {
      const frameNum = parseInt(frameMatch[1], 10);
      if (frameNum > 0) {
        this._onProgress.forEach((cb) => cb(frameNum));
      }
    }
    this._onMessage.forEach((cb) => cb(msg));
  }

  private handleScriptLoadError() {
    this._logger('Failed to load core in worker!');
  }

  private async createScriptURIs() {
    const coreURL = await toBlobURL(this._source);
    const wasmURL = await toBlobURL(this._source.replace('.js', '.wasm'));
    
    // Worker file may not exist for non-threaded builds
    // Try to load it, but don't fail if it doesn't exist
    let workerURL: string | undefined;
    try {
      workerURL = await toBlobURL(this._source.replace('.js', '.worker.js'));
    } catch (error) {
      // Worker file doesn't exist - this is OK for non-threaded builds
      workerURL = undefined;
    }
    
    return {
      core: coreURL,
      wasm: wasmURL,
      worker: workerURL,
    };
  }


  private generateMessageId(): string {
    return `msg_${Date.now()}_${this._messageIdCounter++}`;
  }

  private sendWorkerMessage(type: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = this.generateMessageId();
      this._pendingMessages.set(id, { resolve, reject });

      this._worker.postMessage({ id, type, payload });

      // Timeout after 5 minutes for exec operations (long-running FFmpeg commands)
      // Other operations should be quick
      const timeout = type === 'exec' ? 300000 : 30000;
      setTimeout(() => {
        if (this._pendingMessages.has(id)) {
          this._pendingMessages.delete(id);
          reject(new Error(`Worker message timeout: ${type} (${timeout}ms)`));
        }
      }, timeout);
    });
  }

  private async createWorker() {
    this._uris = await this.createScriptURIs();
    
    // Create inline worker script
    // The worker loads the core and handles all operations
    const workerScript = `
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
        
        // Determine wasmURL and workerURL
        // If not provided, derive from coreURL (as per official implementation)
        const coreURL = config.coreURL;
        const wasmURL = config.wasmURL || coreURL.replace(/.js$/g, '.wasm');
        const workerURL = config.workerURL || coreURL.replace(/.js$/g, '.worker.js');
        
        // Encode wasmURL and workerURL in mainScriptUrlOrBlob (as per official implementation)
        // This is a hack to fix locateFile issue with multi-threaded ffmpeg-core
        const urlConfig = {
          wasmURL: wasmURL,
          workerURL: workerURL,
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
            
            case 'exec': {
              if (!core) {
                throw new Error('Core not loaded');
              }
              
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
                
                // Restore original logger and progress
                core.logger = originalLogger;
                core.progress = originalProgress;
                
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

    // Create worker from blob URL
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const workerURL = URL.createObjectURL(blob);
    this._worker = new Worker(workerURL);

    // Handle worker messages
    this._worker.onmessage = (event: MessageEvent) => {
      const { id, type, success, payload, error } = event.data;

      // Handle log messages
      if (type === 'log' && payload) {
        this.handleMessage(payload.message);
        return;
      }

      // Handle progress messages
      if (type === 'progress' && payload) {
        this._logger(`[Progress] Received from worker: ${JSON.stringify(payload)}`);
        
        // Progress object can have different structures in 0.12
        // It might be { progress: number, time: number } or just a number
        let progressValue = null;
        
        // Helper to validate progress values - reject obviously invalid values
        const isValidProgress = (value: number): boolean => {
          if (!isFinite(value)) return false;
          // If it's a percentage (0-1), it should be in that range
          if (value >= 0 && value <= 1) return true;
          // If it's a frame number, it should be reasonable (not billions)
          // Frame numbers typically don't exceed 10 million for reasonable videos
          if (value > 0 && value < 10000000) return true;
          return false;
        };
        
        if (typeof payload === 'number') {
          if (isValidProgress(payload)) {
            progressValue = payload;
          }
        } else if (payload && typeof payload.progress === 'number') {
          if (isValidProgress(payload.progress)) {
            progressValue = payload.progress;
          }
        } else if (payload && typeof payload.time === 'number') {
          // Validate time value - should be reasonable (not MAX_SAFE_INTEGER or negative huge values)
          if (isFinite(payload.time) && payload.time >= 0 && payload.time < 86400 * 365) {
            progressValue = payload;
          }
        }
        
        if (progressValue !== null) {
          this._onProgress.forEach((cb) => cb(progressValue));
        }
        return;
      }

      // Handle response messages
      if (id && this._pendingMessages.has(id)) {
        const { resolve, reject } = this._pendingMessages.get(id)!;
        this._pendingMessages.delete(id);
        
        if (success) {
          resolve(payload);
        } else {
          reject(new Error(error || 'Unknown error'));
        }
      }
    };

    this._worker.onerror = (error) => {
      this._logger('Worker error:', error);
      this.handleMessage(`Worker error: ${error.message}`);
    };

    // Load the core in the worker
    try {
      await this.sendWorkerMessage('load', {
        coreURL: this._uris.core,
        wasmURL: this._uris.wasm,
        workerURL: this._uris.worker,
      });
      
      this.isReady = true;
      this._whenReady.forEach((cb) => cb());
    } catch (error) {
      this._logger('Failed to load core in worker:', error);
      this.handleScriptLoadError();
    }
  }

  /**
   * Gets called when ffmpeg has been
   * initiated successfully and is ready
   * to receive commands
   */
  public whenReady(cb: types.EventCallback) {
    if (this.isReady) cb();
    else this._whenReady.push(cb);
  }

  /**
   * Gets called when ffmpeg is done executing
   * a script
   */
  public whenExecutionDone(cb: types.EventCallback) {
    this._whenExecutionDone.push(cb);
  }

  /**
   * Gets called when ffmpeg logs a message
   */
  public onMessage(cb: types.MessageCallback) {
    this._onMessage.push(cb);
  }

  /**
   * Remove the callback function from the
   * message callbacks
   */
  public removeOnMessage(cb: types.MessageCallback) {
    this._onMessage = this._onMessage.filter((item) => item != cb);
  }

  /**
   * Gets called when a number of frames
   * has been rendered
   */
  public onProgress(cb: types.ProgressCallback) {
    this._onProgress.push(cb);
  }

  /**
   * Remove the callback function from the
   * progress callbacks
   */
  public removeOnProgress(cb: types.ProgressCallback) {
    this._onProgress = this._onProgress.filter((item) => item != cb);
  }

  /**
   * Use this message to execute ffmpeg commands
   */
  public async exec(args: string[]): Promise<void> {
    if (!this.isReady) {
      throw new Error('FFmpeg is not ready yet. Wait for whenReady() callback.');
    }

    // Execute via worker
    try {
      await this.sendWorkerMessage('exec', { args });
      
      // Wait for execution done callback
      await new Promise<void>((resolve) => {
        this.whenExecutionDone(resolve);
      });

      // add file that has been created to memory
      if (args.at(-1)?.match(/\S\.[A-Za-z0-9_-]{1,20}/)) {
        this._memory.push(args.at(-1) ?? '');
      }
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Read a file that is stored in the memfs
   */
  public async readFile(path: string): Promise<Uint8Array> {
    const result = await this.sendWorkerMessage('readFile', { path });
    return new Uint8Array(result.data);
  }

  /**
   * Delete a file that is stored in the memfs
   */
  public async deleteFile(path: string): Promise<void> {
    try {
      await this.sendWorkerMessage('deleteFile', { path });
    } catch (e) {
      // Silently fail if file doesn't exist
    }
  }

  /**
   * Write a file to the memfs
   */
  public async writeFile(path: string, file: string | Blob): Promise<void> {
    const data: Uint8Array = await toUint8Array(file);
    await this.sendWorkerMessage('writeFile', { path, data: Array.from(data) });
    this._memory.push(path);
  }

  /**
   * Call this method to delete all files that
   * have been written to the memfs memory
   */
  public clearMemory(): void {
    for (const path of [...new Set(this._memory)]) {
      this.deleteFile(path);
    }
    this._memory = [];
  }
}
