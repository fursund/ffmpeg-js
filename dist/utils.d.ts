import * as types from './types';
/**
 * Get uint 8 array from a blob or url
 */
export declare const toUint8Array: (data: Blob | string) => Promise<Uint8Array>;
/**
 * Create local url for external script to
 * work around cors issues
 */
export declare const toBlobURL: (url: string) => Promise<string>;
/**
 * Noop logger
 */
export declare const noop: (msg?: any, ...params: any[]) => void;
/**
 * Parse a ffmpeg progress event output
 */
export declare const parseProgress: (msg: string) => number;
/**
 * Parse a ffmpeg message and extract the meta
 * data of the input
 * @param data reference to the object that should
 * recieve the data
 * @returns Callback function that can be passed into
 * the onMessage function
 */
export declare const parseMetadata: (data: types.Metadata) => (msg: string) => void;
