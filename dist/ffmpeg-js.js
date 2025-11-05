var w = Object.defineProperty;
var b = (l, s, e) => s in l ? w(l, s, { enumerable: !0, configurable: !0, writable: !0, value: e }) : l[s] = e;
var g = (l, s, e) => (b(l, typeof s != "symbol" ? s + "" : s, e), e);
const y = async (l) => {
  let s;
  return typeof l == "string" ? s = await (await fetch(l)).arrayBuffer() : s = await await l.arrayBuffer(), new Uint8Array(s);
}, h = async (l) => {
  var o;
  const s = {
    js: "application/javascript",
    wasm: "application/wasm"
  }, e = await (await fetch(l)).arrayBuffer(), r = l.includes(".worker.js") ? "js" : ((o = l.split(".")) == null ? void 0 : o.at(-1)) ?? "js", t = new Blob([e], {
    type: s[r] || "application/javascript"
  });
  return URL.createObjectURL(t);
}, m = (l, ...s) => {
}, _ = (l) => (s) => {
  var e, r, t, o, i, n, a, u;
  if (s.match(/Input #/) && Object.assign(l, {
    formats: s.replace(/(Input #|from 'probe')/gm, "").split(",").map((c) => c.trim()).filter((c) => c.length > 1)
  }), s.match(/Duration:/)) {
    const c = s.split(",");
    for (const f of c) {
      if (f.match(/Duration:/)) {
        const p = f.replace(/Duration:/, "").trim();
        Object.assign(l, {
          duration: Date.parse(`01 Jan 1970 ${p} GMT`) / 1e3
        });
      }
      if (f.match(/bitrate:/)) {
        const p = f.replace(/bitrate:/, "").trim();
        Object.assign(l, { bitrate: p });
      }
    }
  }
  if (s.match(/Stream #/)) {
    const c = s.split(","), f = {
      id: (r = (e = c == null ? void 0 : c.at(0)) == null ? void 0 : e.match(/[0-9]{1,2}:[0-9]{1,2}/)) == null ? void 0 : r.at(0)
    };
    if (s.match(/Video/)) {
      const p = f;
      for (const d of c)
        d.match(/Video:/) && Object.assign(p, {
          codec: (i = (o = (t = d.match(/Video:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : t.at(0)) == null ? void 0 : o.replace(/Video:/, "")) == null ? void 0 : i.trim()
        }), d.match(/[0-9]*x[0-9]*/) && (Object.assign(p, { width: parseFloat(d.split("x")[0]) }), Object.assign(p, { height: parseFloat(d.split("x")[1]) })), d.match(/fps/) && Object.assign(p, {
          fps: parseFloat(d.replace("fps", "").trim())
        });
      l.streams.video.push(p);
    }
    if (s.match(/Audio/)) {
      const p = f;
      for (const d of c)
        d.match(/Audio:/) && Object.assign(p, {
          codec: (u = (a = (n = d.match(/Audio:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : n.at(0)) == null ? void 0 : a.replace(/Audio:/, "")) == null ? void 0 : u.trim()
        }), d.match(/hz/i) && Object.assign(p, {
          sampleRate: parseInt(d.replace(/[\D]/gm, ""))
        });
      l.streams.audio.push(p);
    }
  }
};
class k {
  constructor({ logger: s, source: e }) {
    g(this, "_worker", null);
    g(this, "_logger", m);
    g(this, "_source");
    g(this, "_uris");
    g(this, "_whenReady", []);
    g(this, "_whenExecutionDone", []);
    g(this, "_onMessage", []);
    g(this, "_onProgress", []);
    g(this, "_memory", []);
    g(this, "_pendingMessages", /* @__PURE__ */ new Map());
    g(this, "_messageIdCounter", 0);
    /**
     * Is true when the script has been
     * loaded successfully
     */
    g(this, "isReady", !1);
    this._source = e, this._logger = s, this.createWorker();
  }
  /**
   * Handles the ffmpeg logs
   */
  handleMessage(s) {
    this._logger(s), s.match(/(FFMPEG_END|error)/i) && this._whenExecutionDone.forEach((r) => r());
    const e = s.match(/frame=\s*(\d+)/);
    if (e) {
      const r = parseInt(e[1], 10);
      r > 0 && this._onProgress.forEach((t) => t(r));
    }
    this._onMessage.forEach((r) => r(s));
  }
  handleScriptLoadError() {
    this._logger("Failed to load core in worker!");
  }
  async createScriptURIs() {
    const s = await h(this._source), e = await h(this._source.replace(".js", ".wasm"));
    let r;
    try {
      r = await h(this._source.replace(".js", ".worker.js"));
    } catch {
      r = void 0;
    }
    return {
      core: s,
      wasm: e,
      worker: r
    };
  }
  generateMessageId() {
    return `msg_${Date.now()}_${this._messageIdCounter++}`;
  }
  sendWorkerMessage(s, e) {
    return new Promise((r, t) => {
      if (!this._worker) {
        t(new Error("Worker not initialized"));
        return;
      }
      const o = this.generateMessageId();
      this._pendingMessages.set(o, { resolve: r, reject: t }), this._worker.postMessage({ id: o, type: s, payload: e });
      const i = s === "exec" ? 3e5 : 3e4;
      setTimeout(() => {
        this._pendingMessages.has(o) && (this._pendingMessages.delete(o), t(new Error(`Worker message timeout: ${s} (${i}ms)`)));
      }, i);
    });
  }
  async createWorker() {
    this._uris = await this.createScriptURIs();
    const s = `
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
    `, e = new Blob([s], { type: "application/javascript" }), r = URL.createObjectURL(e);
    if (this._worker = new Worker(r), this._worker.onmessage = (t) => {
      const { id: o, type: i, success: n, payload: a, error: u } = t.data;
      if (i === "log" && a) {
        this.handleMessage(a.message);
        return;
      }
      if (i === "progress" && a) {
        let c = null;
        const f = (p) => isFinite(p) ? p >= 0 && p <= 1 || p > 0 && p < 1e7 : !1;
        if (typeof a == "number" ? f(a) && (c = a) : a && typeof a.progress == "number" ? f(a.progress) && (c = a.progress) : a && typeof a.time == "number" && isFinite(a.time) && a.time >= 0 && a.time < 86400 * 365 && (c = a), c !== null) {
          const p = typeof c == "number" ? c : c.time || 0;
          this._onProgress.forEach((d) => d(p));
        }
        return;
      }
      if (o && this._pendingMessages.has(o)) {
        const { resolve: c, reject: f } = this._pendingMessages.get(o);
        this._pendingMessages.delete(o), n ? c(a) : f(new Error(u || "Unknown error"));
      }
    }, this._worker.onerror = (t) => {
      this._logger("Worker error:", t), this.handleMessage(`Worker error: ${t.message}`);
    }, !this._uris)
      throw new Error("URIs not initialized");
    try {
      await this.sendWorkerMessage("load", {
        coreURL: this._uris.core,
        wasmURL: this._uris.wasm,
        workerURL: this._uris.worker
      }), this.isReady = !0, this._whenReady.forEach((t) => t());
    } catch (t) {
      this._logger("Failed to load core in worker:", t), this.handleScriptLoadError();
    }
  }
  /**
   * Gets called when ffmpeg has been
   * initiated successfully and is ready
   * to receive commands
   */
  whenReady(s) {
    this.isReady ? s() : this._whenReady.push(s);
  }
  /**
   * Gets called when ffmpeg is done executing
   * a script
   */
  whenExecutionDone(s) {
    this._whenExecutionDone.push(s);
  }
  /**
   * Gets called when ffmpeg logs a message
   */
  onMessage(s) {
    this._onMessage.push(s);
  }
  /**
   * Remove the callback function from the
   * message callbacks
   */
  removeOnMessage(s) {
    this._onMessage = this._onMessage.filter((e) => e != s);
  }
  /**
   * Gets called when a number of frames
   * has been rendered
   */
  onProgress(s) {
    this._onProgress.push(s);
  }
  /**
   * Remove the callback function from the
   * progress callbacks
   */
  removeOnProgress(s) {
    this._onProgress = this._onProgress.filter((e) => e != s);
  }
  /**
   * Use this message to execute ffmpeg commands
   */
  async exec(s) {
    var e;
    if (!this.isReady)
      throw new Error("FFmpeg is not ready yet. Wait for whenReady() callback.");
    try {
      await this.sendWorkerMessage("exec", { args: s }), await new Promise((r) => {
        this.whenExecutionDone(r);
      }), (e = s.at(-1)) != null && e.match(/\S\.[A-Za-z0-9_-]{1,20}/) && this._memory.push(s.at(-1) ?? "");
    } catch (r) {
      throw r;
    }
  }
  /**
   * Read a file that is stored in the memfs
   */
  async readFile(s) {
    const e = await this.sendWorkerMessage("readFile", { path: s });
    return new Uint8Array(e.data);
  }
  /**
   * Delete a file that is stored in the memfs
   */
  async deleteFile(s) {
    try {
      await this.sendWorkerMessage("deleteFile", { path: s });
    } catch {
    }
  }
  /**
   * Write a file to the memfs
   */
  async writeFile(s, e) {
    const r = await y(e);
    await this.sendWorkerMessage("writeFile", { path: s, data: Array.from(r) }), this._memory.push(s);
  }
  /**
   * Call this method to delete all files that
   * have been written to the memfs memory
   */
  clearMemory() {
    for (const s of [...new Set(this._memory)])
      this.deleteFile(s);
    this._memory = [];
  }
}
const O = {
  "lgpl-base": "/ffmpeg-core.js",
  "gpl-extended": "/ffmpeg-core.js"
  // User placed UMD files in public/
};
class F extends k {
  constructor(e = {}) {
    let r = console.log, t = O[(e == null ? void 0 : e.config) ?? "lgpl-base"];
    (e == null ? void 0 : e.log) == !1 && (r = m), e != null && e.source && (t = e.source);
    super({ logger: r, source: t });
    g(this, "_inputs", []);
    g(this, "_output");
    g(this, "_middleware", []);
  }
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
  async codecs() {
    const e = {
      encoders: {},
      decoders: {}
    }, r = {
      video: JSON.parse(JSON.stringify(e)),
      audio: JSON.parse(JSON.stringify(e))
    }, t = (o) => {
      o = o.substring(7).replace(/\W{2,}/, " ").trim();
      const i = o.split(" "), n = i.shift() ?? "", a = i.join(" ");
      return { [n]: a };
    };
    return this.onMessage((o) => {
      o = o.trim();
      let i = [];
      if (o.match(/[DEVASIL\.]{6}\W(?!=)/)) {
        o.match(/^D.V/) && i.push(["video", "decoders"]), o.match(/^.EV/) && i.push(["video", "encoders"]), o.match(/^D.A/) && i.push(["audio", "decoders"]), o.match(/^.EA/) && i.push(["audio", "encoders"]);
        for (const [n, a] of i)
          Object.assign(r[n][a], t(o));
      }
    }), await this.exec(["-codecs"]), r;
  }
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
  async formats() {
    const e = {
      muxers: {},
      demuxers: {}
    }, r = (t) => {
      t = t.substring(3).replace(/\W{2,}/, " ").trim();
      const o = t.split(" "), i = o.shift() ?? "", n = o.join(" ");
      return { [i]: n };
    };
    return this.onMessage((t) => {
      t = t.substring(1);
      let o = [];
      if (t.match(/[DE\.]{2}\W(?!=)/)) {
        t.match(/^D./) && o.push("demuxers"), t.match(/^.E/) && o.push("muxers");
        for (const i of o)
          Object.assign(e[i], r(t));
      }
    }), await this.exec(["-formats"]), e;
  }
  /**
   * Add a new input using the specified options
   */
  input(e) {
    return (this._middleware.length > 0 || this._output) && (this._inputs = [], this._middleware = [], this._output = void 0, this.clearMemory()), this._inputs.push(e), this;
  }
  /**
   * Define the ouput format
   */
  ouput(e) {
    return this._output = e, this;
  }
  /**
   * Add an audio filter [see](https://ffmpeg.org/ffmpeg-filters.html#Audio-Filters)
   * for more information
   */
  audioFilter(e) {
    if (this._middleware.push("-af", e), this._inputs.length > 1)
      throw new Error(
        "Cannot use filters on multiple outputs, please use filterComplex instead"
      );
    return this;
  }
  /**
   * Add an video filter [see](https://ffmpeg.org/ffmpeg-filters.html#Video-Filters)
   * for more information
   */
  videoFilter(e) {
    if (this._middleware.push("-vf", e), this._inputs.length > 1)
      throw new Error(
        "Cannot use filters on multiple outputs, please use filterComplex instead"
      );
    return this;
  }
  /**
   * Add a complex filter to multiple videos [see](https://ffmpeg.org/ffmpeg-filters.html)
   * for more information
   */
  complexFilter(e) {
    return this._middleware.push("-filter_complex", e), this;
  }
  /**
   * Choose which input should be inclueded in the output [see](https://trac.ffmpeg.org/wiki/Map)
   * for more information
   */
  map(e) {
    return this._middleware.push("-map", e), this;
  }
  /**
   * Append additional ffmpeg arguments that are not covered by
   * the convenience methods.
   */
  otherArgs(e) {
    return this._middleware.push(...e), this;
  }
  /**
   * Get the ffmpeg command from the specified
   * inputs and outputs.
   */
  async command() {
    const e = [];
    return e.push(...await this.parseInputOptions()), e.push(...this._middleware), e.push(...await this.parseOutputOptions()), e;
  }
  /**
   * Exports the specified input(s)
   */
  async export() {
    const e = await this.command();
    await this.exec(e);
    const r = await this.readFile(e.at(-1) ?? "");
    return this.clearMemory(), r;
  }
  /**
   * Get the meta data of a the specified file.
   * Returns information such as codecs, fps, bitrate etc.
   */
  async meta(e) {
    await this.writeFile("probe", e);
    const r = {
      streams: { audio: [], video: [] }
    }, t = _(r);
    return this.onMessage(t), await this.exec(["-i", "probe"]), this.removeOnMessage(t), this.clearMemory(), r;
  }
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
  async *thumbnails(e, r = 5, t = 0, o) {
    if (!o) {
      const { duration: n } = await this.meta(e);
      n ? o = n : (console.warn(
        "Could not extract duration from meta data please provide a stop argument. Falling back to 1sec otherwise."
      ), o = 1);
    }
    const i = (o - t) / r;
    await this.writeFile("input", e);
    for (let n = t; n < o; n += i) {
      await this.exec([
        "-ss",
        n.toString(),
        "-i",
        "input",
        "-frames:v",
        "1",
        "image.jpg"
      ]);
      try {
        const a = await this.readFile("image.jpg"), u = new ArrayBuffer(a.length);
        new Uint8Array(u).set(a), yield new Blob([u], { type: "image/jpeg" });
      } catch {
      }
    }
    this.clearMemory();
  }
  parseOutputOptions() {
    if (!this._output)
      throw new Error("Please define the output first");
    const { format: e, path: r, audio: t, video: o, seek: i, duration: n } = this._output, a = [];
    let u = `output.${e}`;
    return r && (u = r + u), i && a.push("-ss", i.toString()), n && a.push("-t", n.toString()), a.push(...this.parseAudioOutput(t)), a.push(...this.parseVideoOutput(o)), a.push(u), a;
  }
  parseAudioOutput(e) {
    if (!e)
      return [];
    if ("disableAudio" in e)
      return e.disableAudio ? ["-an"] : [];
    const r = [];
    return e.codec && r.push("-c:a", e.codec), e.bitrate && r.push("-b:a", e.bitrate.toString()), e.numberOfChannels && r.push("-ac", e.numberOfChannels.toString()), e.volume && r.push("-vol", e.volume.toString()), e.sampleRate && r.push("-ar", e.sampleRate.toString()), r;
  }
  parseVideoOutput(e) {
    if (!e)
      return [];
    if ("disableVideo" in e)
      return e.disableVideo ? ["-vn"] : [];
    const r = [];
    return e.codec && r.push("-c:v", e.codec), e.bitrate && r.push("-b:v", e.bitrate.toString()), e.aspectRatio && r.push("-aspect", e.aspectRatio.toString()), e.framerate && r.push("-r", e.framerate.toString()), e.size && r.push("-s", `${e.size.width}x${e.size.height}`), r;
  }
  async parseInputOptions() {
    const e = [];
    for (const r of this._inputs)
      e.push(...await this.parseImageInput(r)), e.push(...await this.parseMediaInput(r));
    return e;
  }
  async parseImageInput(e) {
    if (!("sequence" in e))
      return [];
    const r = e.sequence.length.toString().length, t = "image-sequence-";
    let o = `${t}%0${r}d`;
    const i = [];
    for (const [n, a] of e.sequence.entries())
      if (a instanceof Blob || a.match(/(^http(s?):\/\/|^\/\S)/)) {
        const u = `${t}${n.toString().padStart(n, "0")}`;
        await this.writeFile(u, a);
      } else {
        const u = a.match(/[0-9]{1,20}/);
        if (u) {
          const [c] = u;
          o = a.replace(/[0-9]{1,20}/, `%0${c.length}d`);
        }
      }
    return i.push("-framerate", e.framerate.toString()), i.push("-i", o), i;
  }
  async parseMediaInput(e) {
    if (!("source" in e))
      return [];
    const { source: r } = e, t = [], o = `input-${(/* @__PURE__ */ new Date()).getTime()}`;
    return e.seek && t.push("-ss", e.seek.toString()), r instanceof Blob || r.match(/(^http(s?):\/\/|^\/\S)/) ? (await this.writeFile(o, r), t.push("-i", o)) : t.push("-i", r), t;
  }
}
export {
  F as FFmpeg
};
