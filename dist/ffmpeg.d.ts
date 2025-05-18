import { IFFmpegConfiguration } from './interfaces';
import { FFmpegBase } from './ffmpeg-base';
import * as types from './types';
export declare class FFmpeg<Config extends IFFmpegConfiguration<string, string, string> = types.FFmpegConfiguration> extends FFmpegBase {
    private _inputs;
    private _output?;
    private _middleware;
    constructor(settings?: types.FFmpegSettings);
    /**
     * Get all supported video decoders, encoders and
     * audio decoder, encoders. You can test if a codec
     * is available like so:
     * @example
     * const codecs = await ffmpeg.codecs();
     *
     * if ("aac" in codecs.audio.encoders) {
     *  // do something
     * }
     */
    codecs(): Promise<types.SupportedCodecs>;
    /**
     * Get all supported muxers and demuxers, e.g. mp3, webm etc.
     * You can test if a format is available like this:
     * @example
     * const formats = await ffmpeg.formats();
     *
     * if ("mp3" in formats.demuxers) {
     *  // do something
     * }
     */
    formats(): Promise<types.SupportedFormats>;
    /**
     * Add a new input using the specified options
     */
    input(options: types.InputOptions): this;
    /**
     * Define the ouput format
     */
    ouput(options: types.OutputOptions<Config>): this;
    /**
     * Add an audio filter [see](https://ffmpeg.org/ffmpeg-filters.html#Audio-Filters)
     * for more information
     */
    audioFilter(filter: string): this;
    /**
     * Add an video filter [see](https://ffmpeg.org/ffmpeg-filters.html#Video-Filters)
     * for more information
     */
    videoFilter(filter: string): this;
    /**
     * Add a complex filter to multiple videos [see](https://ffmpeg.org/ffmpeg-filters.html)
     * for more information
     */
    complexFilter(filter: string): this;
    /**
     * Choose which input should be inclueded in the output [see](https://trac.ffmpeg.org/wiki/Map)
     * for more information
     */
    map(input: string): this;
    /**
     * Append additional ffmpeg arguments that are not covered by
     * the convenience methods.
     */
    otherArgs(args: string[]): this;
    /**
     * Get the ffmpeg command from the specified
     * inputs and outputs.
     */
    command(): Promise<string[]>;
    /**
     * Exports the specified input(s)
     */
    export(): Promise<Uint8Array | undefined>;
    /**
     * Get the meta data of a the specified file.
     * Returns information such as codecs, fps, bitrate etc.
     */
    meta(source: string | Blob): Promise<types.Metadata>;
    /**
     * Generate a series of thumbnails
     * @param source Your input file
     * @param count The number of thumbnails to generate
     * @param start Lower time limit in seconds
     * @param stop Upper time limit in seconds
     * @example
     * // type AsyncGenerator<Blob, void, void>
     * const generator = ffmpeg.thumbnails('/samples/video.mp4');
     *
     * for await (const image of generator) {
     *    const img = document.createElement('img');
     *    img.src = URL.createObjectURL(image);
     *    document.body.appendChild(img);
     * }
     */
    thumbnails(source: string | Blob, count?: number, start?: number, stop?: number): AsyncGenerator<Blob, void, void>;
    private parseOutputOptions;
    private parseAudioOutput;
    private parseVideoOutput;
    private parseInputOptions;
    private parseImageInput;
    private parseMediaInput;
}
