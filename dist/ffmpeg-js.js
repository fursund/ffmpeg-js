var w = Object.defineProperty;
var y = (l, r, e) => r in l ? w(l, r, { enumerable: !0, configurable: !0, writable: !0, value: e }) : l[r] = e;
var u = (l, r, e) => (y(l, typeof r != "symbol" ? r + "" : r, e), e);
const b = async (l) => {
  let r;
  return typeof l == "string" ? r = await (await fetch(l)).arrayBuffer() : r = await await l.arrayBuffer(), new Uint8Array(r);
}, f = async (l) => {
  var s;
  const r = {
    js: "application/javascript",
    wasm: "application/wasm"
  }, e = await (await fetch(l)).arrayBuffer(), t = l.includes(".worker.js") ? "js" : ((s = l.split(".")) == null ? void 0 : s.at(-1)) ?? "js", a = new Blob([e], {
    type: r[t] || "application/javascript"
  });
  return URL.createObjectURL(a);
}, m = (l, ...r) => {
}, _ = (l) => (r) => {
  var e, t, a, s, i, o, c, n;
  if (r.match(/Input #/) && Object.assign(l, {
    formats: r.replace(/(Input #|from 'probe')/gm, "").split(",").map((p) => p.trim()).filter((p) => p.length > 1)
  }), r.match(/Duration:/)) {
    const p = r.split(",");
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
  if (r.match(/Stream #/)) {
    const p = r.split(","), d = {
      id: (t = (e = p == null ? void 0 : p.at(0)) == null ? void 0 : e.match(/[0-9]{1,2}:[0-9]{1,2}/)) == null ? void 0 : t.at(0)
    };
    if (r.match(/Video/)) {
      const g = d;
      for (const h of p)
        h.match(/Video:/) && Object.assign(g, {
          codec: (i = (s = (a = h.match(/Video:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : a.at(0)) == null ? void 0 : s.replace(/Video:/, "")) == null ? void 0 : i.trim()
        }), h.match(/[0-9]*x[0-9]*/) && (Object.assign(g, { width: parseFloat(h.split("x")[0]) }), Object.assign(g, { height: parseFloat(h.split("x")[1]) })), h.match(/fps/) && Object.assign(g, {
          fps: parseFloat(h.replace("fps", "").trim())
        });
      l.streams.video.push(g);
    }
    if (r.match(/Audio/)) {
      const g = d;
      for (const h of p)
        h.match(/Audio:/) && Object.assign(g, {
          codec: (n = (c = (o = h.match(/Audio:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : o.at(0)) == null ? void 0 : c.replace(/Audio:/, "")) == null ? void 0 : n.trim()
        }), h.match(/hz/i) && Object.assign(g, {
          sampleRate: parseInt(h.replace(/[\D]/gm, ""))
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
                // In template string, need \\\\ to get \\ in the string, which becomes  in the regex
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
              
              // Parse progress from log messages using out_time_ms
              // -progress pipe:1 outputs key=value pairs, one per line
              // Format: "out_time_ms=4914000"
              if (knownDurationSec !== null && knownDurationSec > 0) {
                // Use RegExp constructor with double-escaped backslashes for template string
                const timeMsRegex = new RegExp('out_time_ms\\\\s*=\\\\s*(\\\\d+)', 'i');
                const timeMsMatch = message.match(timeMsRegex);
                if (timeMsMatch) {
                  // out_time_ms is in microseconds, not milliseconds! Divide by 1,000,000
                  const currentTimeSec = parseInt(timeMsMatch[1], 10) / 1000000;
                  if (currentTimeSec >= 0 && isFinite(currentTimeSec)) {
                    // Calculate ratio - allow it to go to 1.0 naturally
                    const ratio = Math.max(0, Math.min(1, currentTimeSec / knownDurationSec));
                    // Debug: log progress calculation
                    self.postMessage({
                      type: 'log',
                      payload: { type: 'debug', message: 'DEBUG: Progress: out_time_ms=' + timeMsMatch[1] + ' (microseconds), currentTimeSec=' + currentTimeSec.toFixed(3) + ', duration=' + knownDurationSec.toFixed(3) + ', ratio=' + ratio.toFixed(4) }
                    });
                    self.postMessage({ 
                      type: 'progress', 
                      payload: ratio 
                    });
                  }
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
class M {
  constructor({ logger: r, source: e }) {
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
    this._source = e, this._logger = r, this.createWorker();
  }
  /**
   * Handles the ffmpeg logs
   */
  handleMessage(r) {
    this._logger(r), r.match(/(FFMPEG_END|error)/i) && this._whenExecutionDone.forEach((e) => e()), this._onMessage.forEach((e) => e(r));
  }
  handleScriptLoadError() {
    this._logger("Failed to load core in worker!");
  }
  async createScriptURIs() {
    const r = await f(this._source), e = await f(this._source.replace(".js", ".wasm"));
    return {
      core: r,
      wasm: e
    };
  }
  generateMessageId() {
    return `msg_${Date.now()}_${this._messageIdCounter++}`;
  }
  sendWorkerMessage(r, e, t) {
    return new Promise((a, s) => {
      if (!this._worker) {
        s(new Error("Worker not initialized"));
        return;
      }
      const i = t || this.generateMessageId();
      this._pendingMessages.set(i, { resolve: a, reject: s }), this._worker.postMessage({ id: i, type: r, payload: e });
      const o = r === "exec" ? 3e5 : 3e4;
      setTimeout(() => {
        this._pendingMessages.has(i) && (this._pendingMessages.delete(i), s(new Error(`Worker message timeout: ${r} (${o}ms)`)));
      }, o);
    });
  }
  async createWorker() {
    this._uris = await this.createScriptURIs();
    const r = new Blob([x], { type: "application/javascript" }), e = URL.createObjectURL(r);
    if (this._worker = new Worker(e), this._worker.onmessage = (t) => {
      const { id: a, type: s, success: i, payload: o, error: c } = t.data;
      if (s === "log" && o) {
        this.handleMessage(o.message);
        return;
      }
      if (s === "progress" && o !== void 0 && o !== null) {
        let n = null;
        const p = (d) => isFinite(d) ? d >= 0 && d <= 1 || d > 0 && d < 1e7 : !1;
        if (typeof o == "number" ? p(o) && (n = o) : o && typeof o.progress == "number" ? p(o.progress) && (n = o.progress) : o && typeof o.time == "number" && isFinite(o.time) && o.time >= 0 && o.time < 86400 * 365 && (n = o), n !== null) {
          const d = typeof n == "number" ? n : n.time || 0;
          console.log("FFmpeg progress:", d, "callbacks:", this._onProgress.length), this._onProgress.forEach((g) => g(d));
        } else
          console.log("FFmpeg progress rejected:", { payload: o, type: typeof o });
        return;
      }
      if ((s === "exec" || s === "terminate") && this._whenExecutionDone.forEach((n) => n()), a && this._pendingMessages.has(a)) {
        const { resolve: n, reject: p } = this._pendingMessages.get(a);
        this._pendingMessages.delete(a), i ? n(o) : p(new Error(c || "Unknown error"));
      }
    }, this._worker.onerror = (t) => {
      this._logger("Worker error:", t), this.handleMessage(`Worker error: ${t.message}`);
    }, !this._uris)
      throw new Error("URIs not initialized");
    try {
      await this.sendWorkerMessage("load", {
        coreURL: this._uris.core,
        wasmURL: this._uris.wasm
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
  whenReady(r) {
    this.isReady ? r() : this._whenReady.push(r);
  }
  /**
   * Gets called when ffmpeg is done executing
   * a script
   */
  whenExecutionDone(r) {
    this._whenExecutionDone.push(r);
  }
  /**
   * Gets called when ffmpeg logs a message
   */
  onMessage(r) {
    this._onMessage.push(r);
  }
  /**
   * Remove the callback function from the
   * message callbacks
   */
  removeOnMessage(r) {
    this._onMessage = this._onMessage.filter((e) => e != r);
  }
  /**
   * Gets called when a number of frames
   * has been rendered
   */
  onProgress(r) {
    this._onProgress.push(r);
  }
  /**
   * Remove the callback function from the
   * progress callbacks
   */
  removeOnProgress(r) {
    this._onProgress = this._onProgress.filter((e) => e != r);
  }
  /**
   * Use this message to execute ffmpeg commands
   */
  async exec(r) {
    var e;
    if (!this.isReady)
      throw new Error("FFmpeg is not ready yet. Wait for whenReady() callback.");
    try {
      const t = this.generateMessageId();
      this._currentExecId = t, await this.sendWorkerMessage("exec", { args: r, id: t }, t), this._currentExecId === t && (this._currentExecId = null), (e = r.at(-1)) != null && e.match(/\S\.[A-Za-z0-9_-]{1,20}/) && this._memory.push(r.at(-1) ?? "");
    } catch (t) {
      throw this._currentExecId = null, t;
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
    const r = this._currentExecId;
    if (this._pendingMessages.has(r)) {
      const { reject: e } = this._pendingMessages.get(r);
      this._pendingMessages.delete(r), e(new Error("FFmpeg execution was terminated"));
    }
    try {
      await this.sendWorkerMessage("terminate", { execId: r }), this._currentExecId = null;
    } catch (e) {
      throw this._currentExecId = null, e;
    }
  }
  /**
   * Read a file that is stored in the memfs
   */
  async readFile(r) {
    const e = await this.sendWorkerMessage("readFile", { path: r });
    return new Uint8Array(e.data);
  }
  /**
   * Delete a file that is stored in the memfs
   */
  async deleteFile(r) {
    try {
      await this.sendWorkerMessage("deleteFile", { path: r });
    } catch {
    }
  }
  /**
   * Write a file to the memfs
   */
  async writeFile(r, e) {
    const t = await b(e);
    await this.sendWorkerMessage("writeFile", { path: r, data: Array.from(t) }), this._memory.push(r);
  }
  /**
   * Call this method to delete all files that
   * have been written to the memfs memory
   */
  clearMemory() {
    for (const r of [...new Set(this._memory)])
      this.deleteFile(r);
    this._memory = [];
  }
}
const k = {
  "lgpl-base": "/ffmpeg-core.js",
  "gpl-extended": "/ffmpeg-core.js"
  // User placed UMD files in public/
};
class S extends M {
  constructor(e = {}) {
    let t = console.log, a = k[(e == null ? void 0 : e.config) ?? "lgpl-base"];
    (e == null ? void 0 : e.log) == !1 && (t = m), e != null && e.source && (a = e.source);
    super({ logger: t, source: a });
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
    }, t = {
      video: JSON.parse(JSON.stringify(e)),
      audio: JSON.parse(JSON.stringify(e))
    }, a = (s) => {
      s = s.substring(7).replace(/\W{2,}/, " ").trim();
      const i = s.split(" "), o = i.shift() ?? "", c = i.join(" ");
      return { [o]: c };
    };
    return this.onMessage((s) => {
      s = s.trim();
      let i = [];
      if (s.match(/[DEVASIL\.]{6}\W(?!=)/)) {
        s.match(/^D.V/) && i.push(["video", "decoders"]), s.match(/^.EV/) && i.push(["video", "encoders"]), s.match(/^D.A/) && i.push(["audio", "decoders"]), s.match(/^.EA/) && i.push(["audio", "encoders"]);
        for (const [o, c] of i)
          Object.assign(t[o][c], a(s));
      }
    }), await this.exec(["-codecs"]), t;
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
    }, t = (a) => {
      a = a.substring(3).replace(/\W{2,}/, " ").trim();
      const s = a.split(" "), i = s.shift() ?? "", o = s.join(" ");
      return { [i]: o };
    };
    return this.onMessage((a) => {
      a = a.substring(1);
      let s = [];
      if (a.match(/[DE\.]{2}\W(?!=)/)) {
        a.match(/^D./) && s.push("demuxers"), a.match(/^.E/) && s.push("muxers");
        for (const i of s)
          Object.assign(e[i], t(a));
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
    const t = await this.readFile(e.at(-1) ?? "");
    return this.clearMemory(), t;
  }
  /**
   * Get the meta data of a the specified file.
   * Returns information such as codecs, fps, bitrate etc.
   */
  async meta(e) {
    await this.writeFile("probe", e);
    const t = {
      streams: { audio: [], video: [] }
    }, a = _(t);
    return this.onMessage(a), await this.exec(["-i", "probe", "-f", "null", "-"]), this.removeOnMessage(a), this.clearMemory(), t;
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
  async *thumbnails(e, t = 5, a = 0, s) {
    if (!s) {
      const { duration: o } = await this.meta(e);
      o ? s = o : (console.warn(
        "Could not extract duration from meta data please provide a stop argument. Falling back to 1sec otherwise."
      ), s = 1);
    }
    const i = (s - a) / t;
    await this.writeFile("input", e);
    for (let o = a; o < s; o += i) {
      await this.exec([
        "-ss",
        o.toString(),
        "-i",
        "input",
        "-frames:v",
        "1",
        "image.jpg"
      ]);
      try {
        const c = await this.readFile("image.jpg"), n = new ArrayBuffer(c.length);
        new Uint8Array(n).set(c), yield new Blob([n], { type: "image/jpeg" });
      } catch {
      }
    }
    this.clearMemory();
  }
  parseOutputOptions() {
    if (!this._output)
      throw new Error("Please define the output first");
    const { format: e, path: t, audio: a, video: s, seek: i, duration: o } = this._output, c = [];
    let n = `output.${e}`;
    return t && (n = t + n), i && c.push("-ss", i.toString()), o && c.push("-t", o.toString()), c.push(...this.parseAudioOutput(a)), c.push(...this.parseVideoOutput(s)), c.push(n), c;
  }
  parseAudioOutput(e) {
    if (!e)
      return [];
    if ("disableAudio" in e)
      return e.disableAudio ? ["-an"] : [];
    const t = [];
    return e.codec && t.push("-c:a", e.codec), e.bitrate && t.push("-b:a", e.bitrate.toString()), e.numberOfChannels && t.push("-ac", e.numberOfChannels.toString()), e.volume && t.push("-vol", e.volume.toString()), e.sampleRate && t.push("-ar", e.sampleRate.toString()), t;
  }
  parseVideoOutput(e) {
    if (!e)
      return [];
    if ("disableVideo" in e)
      return e.disableVideo ? ["-vn"] : [];
    const t = [];
    return e.codec && t.push("-c:v", e.codec), e.bitrate && t.push("-b:v", e.bitrate.toString()), e.aspectRatio && t.push("-aspect", e.aspectRatio.toString()), e.framerate && t.push("-r", e.framerate.toString()), e.size && t.push("-s", `${e.size.width}x${e.size.height}`), t;
  }
  async parseInputOptions() {
    const e = [];
    for (const t of this._inputs)
      e.push(...await this.parseImageInput(t)), e.push(...await this.parseMediaInput(t));
    return e;
  }
  async parseImageInput(e) {
    if (!("sequence" in e))
      return [];
    const t = e.sequence.length.toString().length, a = "image-sequence-";
    let s = `${a}%0${t}d`;
    const i = [];
    for (const [o, c] of e.sequence.entries())
      if (c instanceof Blob || c.match(/(^http(s?):\/\/|^\/\S)/)) {
        const n = `${a}${o.toString().padStart(o, "0")}`;
        await this.writeFile(n, c);
      } else {
        const n = c.match(/[0-9]{1,20}/);
        if (n) {
          const [p] = n;
          s = c.replace(/[0-9]{1,20}/, `%0${p.length}d`);
        }
      }
    return i.push("-framerate", e.framerate.toString()), i.push("-i", s), i;
  }
  async parseMediaInput(e) {
    if (!("source" in e))
      return [];
    const { source: t } = e, a = [], s = `input-${(/* @__PURE__ */ new Date()).getTime()}`;
    return e.seek && a.push("-ss", e.seek.toString()), t instanceof Blob || t.match(/(^http(s?):\/\/|^\/\S)/) ? (await this.writeFile(s, t), a.push("-i", s)) : a.push("-i", t), a;
  }
}
export {
  S as FFmpeg
};
