import * as types from './types';
export declare class FFmpegBase {
    private _module;
    private _ffmpeg;
    private _logger;
    private _source;
    private _uris?;
    private _whenReady;
    private _whenExecutionDone;
    private _onMessage;
    private _onProgress;
    private _memory;
    /**
     * Is true when the script has been
     * loaded successfully
     */
    isReady: boolean;
    constructor({ logger, source }: types.FFmpegBaseSettings);
    /**
     * Handles the ffmpeg logs
     */
    private handleMessage;
    private handleScriptLoadError;
    private createScriptURIs;
    private handleLocateFile;
    private handleScriptLoad;
    private createFFmpegScript;
    /**
     * Gets called when ffmpeg has been
     * initiated successfully and is ready
     * to receive commands
     */
    whenReady(cb: types.EventCallback): void;
    /**
     * Gets called when ffmpeg is done executing
     * a script
     */
    whenExecutionDone(cb: types.EventCallback): void;
    /**
     * Gets called when ffmpeg logs a message
     */
    onMessage(cb: types.MessageCallback): void;
    /**
     * Remove the callback function from the
     * message callbacks
     */
    removeOnMessage(cb: types.MessageCallback): void;
    /**
     * Gets called when a number of frames
     * has been rendered
     */
    onProgress(cb: types.ProgressCallback): void;
    /**
     * Remove the callback function from the
     * progress callbacks
     */
    removeOnProgress(cb: types.ProgressCallback): void;
    /**
     * Use this message to execute ffmpeg commands
     */
    exec(args: string[]): Promise<void>;
    /**
     * This method allocates memory required
     * to execute the command
     */
    private parseArgs;
    /**
     * Read a file that is stored in the memfs
     */
    readFile(path: string): Uint8Array;
    /**
     * Delete a file that is stored in the memfs
     */
    deleteFile(path: string): void;
    /**
     * Write a file to the memfs, the first argument
     * is the file name to use. The second argument
     * needs to contain an url to the file or the file
     * as a blob
     */
    writeFile(path: string, file: string | Blob): Promise<void>;
    /**
     * Call this method to delete all files that
     * have been written to the memfs memory
     */
    clearMemory(): void;
}
