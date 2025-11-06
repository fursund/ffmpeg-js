import { noop, toBlobURL, toUint8Array } from './utils';
import * as types from './types';
import { workerScript } from './worker';

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
  private _currentExecId: string | null = null;

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
    // Don't parse frame numbers as progress - we use out_time_ms from logs instead
    // This ensures consistent progress calculation based on time/duration
    this._onMessage.forEach((cb) => cb(msg));
  }

  private handleScriptLoadError() {
    this._logger('Failed to load core in worker!');
  }

  private async createScriptURIs() {
    const coreURL = await toBlobURL(this._source);
    const wasmURL = await toBlobURL(this._source.replace('.js', '.wasm'));
    
    return {
      core: coreURL,
      wasm: wasmURL,
    };
  }


  private generateMessageId(): string {
    return `msg_${Date.now()}_${this._messageIdCounter++}`;
  }

  private sendWorkerMessage(type: string, payload?: any, messageId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = messageId || this.generateMessageId();
      this._pendingMessages.set(id, { resolve, reject });

      this._worker.postMessage({ id, type, payload });

      // No timeout - let operations run until completion
    });
  }

  private async createWorker() {
    this._uris = await this.createScriptURIs();

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
      if (type === 'progress' && payload !== undefined && payload !== null) {
        // Progress object can have different structures in 0.12
        // It might be { progress: number, time: number } or just a number
        let progressValue: number | { time: number } | null = null;
        
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
            // Progress object with optional size
            progressValue = payload;
          }
        } else if (payload && typeof payload.time === 'number') {
          // Validate time value - should be reasonable (not MAX_SAFE_INTEGER or negative huge values)
          if (isFinite(payload.time) && payload.time >= 0 && payload.time < 86400 * 365) {
            progressValue = payload;
          }
        }
        
        if (progressValue !== null) {
          // Pass the full progress value (number or object) to callbacks
          // Debug: log progress forwarding
          console.log('FFmpeg progress:', progressValue, 'callbacks:', this._onProgress.length);
          this._onProgress.forEach((cb) => cb(progressValue as any));
        } else {
          // Debug: log why progress was rejected
          console.log('FFmpeg progress rejected:', { payload, type: typeof payload });
        }
        return;
      }

      // Mark execution done when worker reports exec completion or termination
      if (type === 'exec' || type === 'terminate') {
        this._whenExecutionDone.forEach((cb) => cb());
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
    if (!this._uris) {
      throw new Error('URIs not initialized');
    }
    
    try {
      await this.sendWorkerMessage('load', {
        coreURL: this._uris.core,
        wasmURL: this._uris.wasm,
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
      const execId = this.generateMessageId();
      this._currentExecId = execId;
      
      // Wait for worker to complete execution - the promise resolves when worker sends response
      await this.sendWorkerMessage('exec', { args, id: execId }, execId);

      // Clear current exec ID if it matches
      if (this._currentExecId === execId) {
        this._currentExecId = null;
      }

      // add file that has been created to memory
      if (args.at(-1)?.match(/\S\.[A-Za-z0-9_-]{1,20}/)) {
        this._memory.push(args.at(-1) ?? '');
      }
    } catch (error: any) {
      // Clear current exec ID on error
      this._currentExecId = null;
      throw error;
    }
  }

  /**
   * Terminate the currently running FFmpeg operation
   */
  public async terminate(): Promise<void> {
    if (!this.isReady) {
      throw new Error('FFmpeg is not ready yet. Wait for whenReady() callback.');
    }

    if (!this._currentExecId) {
      // No operation currently running
      return;
    }

    const execId = this._currentExecId;
    
    // Reject the pending exec promise if it exists
    if (this._pendingMessages.has(execId)) {
      const { reject } = this._pendingMessages.get(execId)!;
      this._pendingMessages.delete(execId);
      reject(new Error('FFmpeg execution was terminated'));
    }

    try {
      await this.sendWorkerMessage('terminate', { execId });
      this._currentExecId = null;
    } catch (error: any) {
      // Even if terminate fails, clear the exec ID
      this._currentExecId = null;
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
