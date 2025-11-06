var w = Object.defineProperty;
var y = (l, s, e) => s in l ? w(l, s, { enumerable: !0, configurable: !0, writable: !0, value: e }) : l[s] = e;
var u = (l, s, e) => (y(l, typeof s != "symbol" ? s + "" : s, e), e);
const b = async (l) => {
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
  var e, r, t, o, i, a, n, c;
  if (s.match(/Input #/) && Object.assign(l, {
    formats: s.replace(/(Input #|from 'probe')/gm, "").split(",").map((p) => p.trim()).filter((p) => p.length > 1)
  }), s.match(/Duration:/)) {
    const p = s.split(",");
    for (const d of p) {
      if (d.match(/Duration:/)) {
        const g = d.replace(/Duration:/, "").trim();
        Object.assign(l, {
          duration: Date.parse(`01 Jan 1970 ${g} GMT`) / 1e3
        });
      }
      if (d.match(/bitrate:/)) {
        const g = d.replace(/bitrate:/, "").trim();
        Object.assign(l, { bitrate: g });
      }
    }
  }
  if (s.match(/Stream #/)) {
    const p = s.split(","), d = {
      id: (r = (e = p == null ? void 0 : p.at(0)) == null ? void 0 : e.match(/[0-9]{1,2}:[0-9]{1,2}/)) == null ? void 0 : r.at(0)
    };
    if (s.match(/Video/)) {
      const g = d;
      for (const f of p)
        f.match(/Video:/) && Object.assign(g, {
          codec: (i = (o = (t = f.match(/Video:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : t.at(0)) == null ? void 0 : o.replace(/Video:/, "")) == null ? void 0 : i.trim()
        }), f.match(/[0-9]*x[0-9]*/) && (Object.assign(g, { width: parseFloat(f.split("x")[0]) }), Object.assign(g, { height: parseFloat(f.split("x")[1]) })), f.match(/fps/) && Object.assign(g, {
          fps: parseFloat(f.replace("fps", "").trim())
        });
      l.streams.video.push(g);
    }
    if (s.match(/Audio/)) {
      const g = d;
      for (const f of p)
        f.match(/Audio:/) && Object.assign(g, {
          codec: (c = (n = (a = f.match(/Audio:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : a.at(0)) == null ? void 0 : n.replace(/Audio:/, "")) == null ? void 0 : c.trim()
        }), f.match(/hz/i) && Object.assign(g, {
          sampleRate: parseInt(f.replace(/[\D]/gm, ""))
        });
      l.streams.audio.push(g);
    }
  }
}, x = `
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
class F {
  constructor({ logger: s, source: e }) {
    u(this, "_worker", null);
    u(this, "_logger", m);
    u(this, "_source");
    u(this, "_uris");
    u(this, "_whenReady", []);
    u(this, "_whenExecutionDone", []);
    u(this, "_onMessage", []);
    u(this, "_onProgress", []);
    u(this, "_memory", []);
    u(this, "_pendingMessages", /* @__PURE__ */ new Map());
    u(this, "_messageIdCounter", 0);
    u(this, "_currentExecId", null);
    /**
     * Is true when the script has been
     * loaded successfully
     */
    u(this, "isReady", !1);
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
    return {
      core: s,
      wasm: e
    };
  }
  generateMessageId() {
    return `msg_${Date.now()}_${this._messageIdCounter++}`;
  }
  sendWorkerMessage(s, e, r) {
    return new Promise((t, o) => {
      if (!this._worker) {
        o(new Error("Worker not initialized"));
        return;
      }
      const i = r || this.generateMessageId();
      this._pendingMessages.set(i, { resolve: t, reject: o }), this._worker.postMessage({ id: i, type: s, payload: e });
      const a = s === "exec" ? 3e5 : 3e4;
      setTimeout(() => {
        this._pendingMessages.has(i) && (this._pendingMessages.delete(i), o(new Error(`Worker message timeout: ${s} (${a}ms)`)));
      }, a);
    });
  }
  async createWorker() {
    this._uris = await this.createScriptURIs();
    const s = new Blob([x], { type: "application/javascript" }), e = URL.createObjectURL(s);
    if (this._worker = new Worker(e), this._worker.onmessage = (r) => {
      const { id: t, type: o, success: i, payload: a, error: n } = r.data;
      if (o === "log" && a) {
        this.handleMessage(a.message);
        return;
      }
      if (o === "progress" && a) {
        let c = null;
        const p = (d) => isFinite(d) ? d >= 0 && d <= 1 || d > 0 && d < 1e7 : !1;
        if (typeof a == "number" ? p(a) && (c = a) : a && typeof a.progress == "number" ? p(a.progress) && (c = a.progress) : a && typeof a.time == "number" && isFinite(a.time) && a.time >= 0 && a.time < 86400 * 365 && (c = a), c !== null) {
          const d = typeof c == "number" ? c : c.time || 0;
          this._onProgress.forEach((g) => g(d));
        }
        return;
      }
      if (t && this._pendingMessages.has(t)) {
        const { resolve: c, reject: p } = this._pendingMessages.get(t);
        this._pendingMessages.delete(t), i ? c(a) : p(new Error(n || "Unknown error"));
      }
    }, this._worker.onerror = (r) => {
      this._logger("Worker error:", r), this.handleMessage(`Worker error: ${r.message}`);
    }, !this._uris)
      throw new Error("URIs not initialized");
    try {
      await this.sendWorkerMessage("load", {
        coreURL: this._uris.core,
        wasmURL: this._uris.wasm
      }), this.isReady = !0, this._whenReady.forEach((r) => r());
    } catch (r) {
      this._logger("Failed to load core in worker:", r), this.handleScriptLoadError();
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
      const r = this.generateMessageId();
      this._currentExecId = r, await this.sendWorkerMessage("exec", { args: s, id: r }, r), await new Promise((t) => {
        this.whenExecutionDone(t);
      }), this._currentExecId === r && (this._currentExecId = null), (e = s.at(-1)) != null && e.match(/\S\.[A-Za-z0-9_-]{1,20}/) && this._memory.push(s.at(-1) ?? "");
    } catch (r) {
      throw this._currentExecId = null, r;
    }
  }
  /**
   * Terminate the currently running FFmpeg operation
   */
  async terminate() {
    if (!this.isReady)
      throw new Error("FFmpeg is not ready yet. Wait for whenReady() callback.");
    if (!this._currentExecId)
      return;
    const s = this._currentExecId;
    if (this._pendingMessages.has(s)) {
      const { reject: e } = this._pendingMessages.get(s);
      this._pendingMessages.delete(s), e(new Error("FFmpeg execution was terminated"));
    }
    try {
      await this.sendWorkerMessage("terminate", { execId: s }), this._currentExecId = null;
    } catch (e) {
      throw this._currentExecId = null, e;
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
    const r = await b(e);
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
class M extends F {
  constructor(e = {}) {
    let r = console.log, t = O[(e == null ? void 0 : e.config) ?? "lgpl-base"];
    (e == null ? void 0 : e.log) == !1 && (r = m), e != null && e.source && (t = e.source);
    super({ logger: r, source: t });
    u(this, "_inputs", []);
    u(this, "_output");
    u(this, "_middleware", []);
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
      const i = o.split(" "), a = i.shift() ?? "", n = i.join(" ");
      return { [a]: n };
    };
    return this.onMessage((o) => {
      o = o.trim();
      let i = [];
      if (o.match(/[DEVASIL\.]{6}\W(?!=)/)) {
        o.match(/^D.V/) && i.push(["video", "decoders"]), o.match(/^.EV/) && i.push(["video", "encoders"]), o.match(/^D.A/) && i.push(["audio", "decoders"]), o.match(/^.EA/) && i.push(["audio", "encoders"]);
        for (const [a, n] of i)
          Object.assign(r[a][n], t(o));
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
      const o = t.split(" "), i = o.shift() ?? "", a = o.join(" ");
      return { [i]: a };
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
      const { duration: a } = await this.meta(e);
      a ? o = a : (console.warn(
        "Could not extract duration from meta data please provide a stop argument. Falling back to 1sec otherwise."
      ), o = 1);
    }
    const i = (o - t) / r;
    await this.writeFile("input", e);
    for (let a = t; a < o; a += i) {
      await this.exec([
        "-ss",
        a.toString(),
        "-i",
        "input",
        "-frames:v",
        "1",
        "image.jpg"
      ]);
      try {
        const n = await this.readFile("image.jpg"), c = new ArrayBuffer(n.length);
        new Uint8Array(c).set(n), yield new Blob([c], { type: "image/jpeg" });
      } catch {
      }
    }
    this.clearMemory();
  }
  parseOutputOptions() {
    if (!this._output)
      throw new Error("Please define the output first");
    const { format: e, path: r, audio: t, video: o, seek: i, duration: a } = this._output, n = [];
    let c = `output.${e}`;
    return r && (c = r + c), i && n.push("-ss", i.toString()), a && n.push("-t", a.toString()), n.push(...this.parseAudioOutput(t)), n.push(...this.parseVideoOutput(o)), n.push(c), n;
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
    for (const [a, n] of e.sequence.entries())
      if (n instanceof Blob || n.match(/(^http(s?):\/\/|^\/\S)/)) {
        const c = `${t}${a.toString().padStart(a, "0")}`;
        await this.writeFile(c, n);
      } else {
        const c = n.match(/[0-9]{1,20}/);
        if (c) {
          const [p] = c;
          o = n.replace(/[0-9]{1,20}/, `%0${p.length}d`);
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
  M as FFmpeg
};
