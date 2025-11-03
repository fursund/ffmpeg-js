import { noop, toBlobURL, toUint8Array } from './utils';
import * as types from './types';
import * as utils from './utils';

export class FFmpegBase {
  private _ffmpeg: any; // FFmpeg instance from @ffmpeg/ffmpeg wrapper

  private _logger = noop;
  private _source: string;

  private _uris?: types.WasmModuleURIs;

  private _whenReady: Array<types.EventCallback> = [];
  private _whenExecutionDone: Array<types.EventCallback> = [];

  private _onMessage: Array<types.MessageCallback> = [];
  private _onProgress: Array<types.ProgressCallback> = [];

  private _memory: string[] = [];

  /**
   * Is true when the script has been
   * loaded successfully
   */
  public isReady: boolean = false;

  public constructor({ logger, source }: types.FFmpegBaseSettings) {
    this._source = source;
    this._logger = logger;
    this.initFFmpeg();
  }

  /**
   * Handles the ffmpeg logs
   */
  private handleMessage(msg: string) {
    this._logger(msg);
    // In 0.12, execution completion is handled by the exec() promise, but we still check for errors
    if (msg.match(/error/i)) {
      this._whenExecutionDone.forEach((cb) => cb());
    }
    // Extract frame info from logs for progress compatibility
    if (msg.match(/^frame=/)) {
      this._onProgress.forEach((cb) => cb(utils.parseProgress(msg)));
    }
    this._onMessage.forEach((cb) => cb(msg));
  }

  private async createScriptURIs() {
    return {
      core: await toBlobURL(this._source),
      wasm: await toBlobURL(this._source.replace('.js', '.wasm')),
      worker: await toBlobURL(this._source.replace('.js', '.worker.js')),
    };
  }

  /**
   * Dynamically load @ffmpeg/ffmpeg wrapper from CDN
   */
  private async loadFFmpegWrapper(): Promise<any> {
    // Load the wrapper from unpkg CDN
    const wrapperUrl = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/esm/ffmpeg.js';
    
    // Use dynamic import to load the module
    const module = await import(/* @vite-ignore */ wrapperUrl);
    return module.FFmpeg;
  }

  private async initFFmpeg() {
    try {
      // Load the FFmpeg wrapper class dynamically
      const FFmpegClass = await this.loadFFmpegWrapper();
      
      // Create new instance (0.12 API: new FFmpeg() instead of createFFmpeg())
      this._ffmpeg = new FFmpegClass();
      
      // Setup event handlers (0.12 API: .on() instead of setLogger/setProgress)
      this._ffmpeg.on('log', (e: any) => {
        const msg = typeof e === 'string' ? e : e?.message ?? '';
        if (msg) this.handleMessage(msg);
      });
      
      this._ffmpeg.on('progress', (e: any) => {
        // Progress can be a number (0-1) or an object with progress/ratio
        const progressVal = typeof e === 'number' ? e : e?.progress ?? e?.ratio ?? 0;
        if (typeof progressVal === 'number') {
          this._onProgress.forEach((cb) => {
            if (typeof cb === 'function') {
              // In 0.12, progress is a ratio (0-1), but we also parse frame info from logs for compatibility
              cb(progressVal);
            }
          });
        }
      });

      // Get URIs for core files
      this._uris = await this.createScriptURIs();

      // Load FFmpeg (0.12 API: load options are passed here, not to constructor)
      await this._ffmpeg.load({
        coreURL: this._uris.core,
        wasmURL: this._uris.wasm,
        workerURL: this._uris.worker,
      });

      this._logger('CREATED FFMPEG WASM: loaded');
      this.isReady = true;
      this._whenReady.forEach((cb) => cb());
    } catch (error) {
      this._logger('Failed to load FFmpeg:', error);
      throw error;
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
   * 0.12 API: exec() instead of run()
   */
  public async exec(args: string[]): Promise<void> {
    // 0.12 API: exec takes an array of arguments
    await this._ffmpeg.exec(['-nostdin', '-y', ...args]);

    // add file that has been created to memory
    if (args.at(-1)?.match(/\S\.[A-Za-z0-9_-]{1,20}/)) {
      this._memory.push(args.at(-1) ?? '');
    }
  }

  /**
   * Read a file that is stored in the memfs
   * 0.12 API: await readFile() instead of FS.readFile()
   */
  public async readFile(path: string): Promise<Uint8Array> {
    this._logger('READING FILE:', path);
    const data = await this._ffmpeg.readFile(path);
    return data as Uint8Array;
  }

  /**
   * Delete a file that is stored in the memfs
   * 0.12 API: await deleteFile() instead of FS.unlink()
   */
  public async deleteFile(path: string): Promise<void> {
    try {
      this._logger('DELETING FILE:', path);
      await this._ffmpeg.deleteFile(path);
    } catch (e) {
      this._logger('Could not delete file');
    }
  }

  /**
   * Write a file to the memfs, the first argument
   * is the file name to use. The second argument
   * needs to contain an url to the file or the file
   * as a blob
   * 0.12 API: await writeFile() instead of FS.writeFile()
   */
  public async writeFile(path: string, file: string | Blob): Promise<void> {
    const data: Uint8Array = await toUint8Array(file);
    this._logger('WRITING FILE:', path);
    await this._ffmpeg.writeFile(path, data);
    this._memory.push(path);
  }

  /**
   * Terminate FFmpeg instance
   * 0.12 API: terminate() instead of exit()
   */
  public terminate(): void {
    if (this._ffmpeg && typeof this._ffmpeg.terminate === 'function') {
      this._ffmpeg.terminate();
    }
  }

  /**
   * Call this method to delete all files that
   * have been written to the memfs memory
   */
  public async clearMemory(): Promise<void> {
    for (const path of [...new Set(this._memory)]) {
      await this.deleteFile(path);
    }
    this._memory = [];
  }
}
