var g = Object.defineProperty;
var w = (o, t, e) => t in o ? g(o, t, { enumerable: !0, configurable: !0, writable: !0, value: e }) : o[t] = e;
var h = (o, t, e) => (w(o, typeof t != "symbol" ? t + "" : t, e), e);
const b = async (o) => {
  let t;
  return typeof o == "string" ? t = await (await fetch(o)).arrayBuffer() : t = await await o.arrayBuffer(), new Uint8Array(t);
}, d = async (o) => {
  var i;
  const t = {
    js: "application/javascript",
    wasm: "application/wasm"
  }, e = await (await fetch(o)).arrayBuffer(), s = new Blob([e], {
    type: t[((i = o.split(".")) == null ? void 0 : i.at(-1)) ?? "js"]
  });
  return URL.createObjectURL(s);
}, _ = (o, ...t) => {
}, y = (o) => {
  var e, s, i;
  const t = (i = (s = (e = o.match(/(^frame=)(\W)*([0-9]{1,})(\W)/)) == null ? void 0 : e.at(0)) == null ? void 0 : s.replace(/frame=/, "")) == null ? void 0 : i.trim();
  return parseInt(t ?? "0");
}, F = (o) => (t) => {
  var e, s, i, r, a, c, n, m;
  if (t.match(/Input #/) && Object.assign(o, {
    formats: t.replace(/(Input #|from 'probe')/gm, "").split(",").map((u) => u.trim()).filter((u) => u.length > 1)
  }), t.match(/Duration:/)) {
    const u = t.split(",");
    for (const f of u) {
      if (f.match(/Duration:/)) {
        const p = f.replace(/Duration:/, "").trim();
        Object.assign(o, {
          duration: Date.parse(`01 Jan 1970 ${p} GMT`) / 1e3
        });
      }
      if (f.match(/bitrate:/)) {
        const p = f.replace(/bitrate:/, "").trim();
        Object.assign(o, { bitrate: p });
      }
    }
  }
  if (t.match(/Stream #/)) {
    const u = t.split(","), f = {
      id: (s = (e = u == null ? void 0 : u.at(0)) == null ? void 0 : e.match(/[0-9]{1,2}:[0-9]{1,2}/)) == null ? void 0 : s.at(0)
    };
    if (t.match(/Video/)) {
      const p = f;
      for (const l of u)
        l.match(/Video:/) && Object.assign(p, {
          codec: (a = (r = (i = l.match(/Video:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : i.at(0)) == null ? void 0 : r.replace(/Video:/, "")) == null ? void 0 : a.trim()
        }), l.match(/[0-9]*x[0-9]*/) && (Object.assign(p, { width: parseFloat(l.split("x")[0]) }), Object.assign(p, { height: parseFloat(l.split("x")[1]) })), l.match(/fps/) && Object.assign(p, {
          fps: parseFloat(l.replace("fps", "").trim())
        });
      o.streams.video.push(p);
    }
    if (t.match(/Audio/)) {
      const p = f;
      for (const l of u)
        l.match(/Audio:/) && Object.assign(p, {
          codec: (m = (n = (c = l.match(/Audio:\W*[a-z0-9_-]*\W/i)) == null ? void 0 : c.at(0)) == null ? void 0 : n.replace(/Audio:/, "")) == null ? void 0 : m.trim()
        }), l.match(/hz/i) && Object.assign(p, {
          sampleRate: parseInt(l.replace(/[\D]/gm, ""))
        });
      o.streams.audio.push(p);
    }
  }
};
class E {
  constructor({ logger: t, source: e }) {
    h(this, "_module");
    h(this, "_ffmpeg");
    h(this, "_logger", _);
    h(this, "_source");
    h(this, "_uris");
    h(this, "_whenReady", []);
    h(this, "_whenExecutionDone", []);
    h(this, "_onMessage", []);
    h(this, "_onProgress", []);
    h(this, "_memory", []);
    /**
     * Is true when the script has been
     * loaded successfully
     */
    h(this, "isReady", !1);
    this._source = e, this._logger = t, this.createFFmpegScript();
  }
  /**
   * Handles the ffmpeg logs
   */
  handleMessage(t) {
    this._logger(t), t.match(/(FFMPEG_END|error)/i) && this._whenExecutionDone.forEach((e) => e()), t.match(/^frame=/) && this._onProgress.forEach((e) => e(y(t))), this._onMessage.forEach((e) => e(t));
  }
  handleScriptLoadError() {
    this._logger("Failed to load script!");
  }
  async createScriptURIs() {
    return {
      core: await d(this._source),
      wasm: await d(this._source.replace(".js", ".wasm")),
      worker: await d(this._source.replace(".js", ".worker.js"))
    };
  }
  handleLocateFile(t, e) {
    var s, i;
    return t.endsWith("ffmpeg-core.wasm") ? (s = this._uris) == null ? void 0 : s.wasm : t.endsWith("ffmpeg-core.worker.js") ? (i = this._uris) == null ? void 0 : i.worker : e + t;
  }
  async handleScriptLoad() {
    var e;
    const t = await createFFmpegCore({
      mainScriptUrlOrBlob: (e = this._uris) == null ? void 0 : e.core,
      printErr: this.handleMessage.bind(this),
      print: this.handleMessage.bind(this),
      locateFile: this.handleLocateFile.bind(this)
    });
    this._logger("CREATED FFMPEG WASM:", t), this.isReady = !0, this._module = t, this._ffmpeg = this._module.cwrap("proxy_main", "number", [
      "number",
      "number"
    ]), this._whenReady.forEach((s) => s());
  }
  async createFFmpegScript() {
    const t = document.createElement("script");
    this._uris = await this.createScriptURIs(), t.src = this._uris.core, t.type = "text/javascript", t.addEventListener("load", this.handleScriptLoad.bind(this)), t.addEventListener("error", this.handleScriptLoadError.bind(this)), document.head.appendChild(t);
  }
  /**
   * Gets called when ffmpeg has been
   * initiated successfully and is ready
   * to receive commands
   */
  whenReady(t) {
    this.isReady ? t() : this._whenReady.push(t);
  }
  /**
   * Gets called when ffmpeg is done executing
   * a script
   */
  whenExecutionDone(t) {
    this._whenExecutionDone.push(t);
  }
  /**
   * Gets called when ffmpeg logs a message
   */
  onMessage(t) {
    this._onMessage.push(t);
  }
  /**
   * Remove the callback function from the
   * message callbacks
   */
  removeOnMessage(t) {
    this._onMessage = this._onMessage.filter((e) => e != t);
  }
  /**
   * Gets called when a number of frames
   * has been rendered
   */
  onProgress(t) {
    this._onProgress.push(t);
  }
  /**
   * Remove the callback function from the
   * progress callbacks
   */
  removeOnProgress(t) {
    this._onProgress = this._onProgress.filter((e) => e != t);
  }
  /**
   * Use this message to execute ffmpeg commands
   */
  async exec(t) {
    var e;
    this._ffmpeg(...this.parseArgs(["./ffmpeg", "-nostdin", "-y", ...t])), await new Promise((s) => {
      this.whenExecutionDone(s);
    }), (e = t.at(-1)) != null && e.match(/\S\.[A-Za-z0-9_-]{1,20}/) && this._memory.push(t.at(-1) ?? "");
  }
  /**
   * This method allocates memory required
   * to execute the command
   */
  parseArgs(t) {
    const e = this._module._malloc(
      t.length * Uint32Array.BYTES_PER_ELEMENT
    );
    return t.forEach((s, i) => {
      const r = this._module.lengthBytesUTF8(s) + 1, a = this._module._malloc(r);
      this._module.stringToUTF8(s, a, r), this._module.setValue(
        e + Uint32Array.BYTES_PER_ELEMENT * i,
        a,
        "i32"
      );
    }), [t.length, e];
  }
  /**
   * Read a file that is stored in the memfs
   */
  readFile(t) {
    return this._logger("READING FILE:", t), this._module.FS.readFile(t);
  }
  /**
   * Delete a file that is stored in the memfs
   */
  deleteFile(t) {
    try {
      this._logger("DELETING FILE:", t), this._module.FS.unlink(t);
    } catch {
      this._logger("Could not delete file");
    }
  }
  /**
   * Write a file to the memfs, the first argument
   * is the file name to use. The second argument
   * needs to contain an url to the file or the file
   * as a blob
   */
  async writeFile(t, e) {
    const s = await b(e);
    this._logger("WRITING FILE:", t), this._module.FS.writeFile(t, s), this._memory.push(t);
  }
  /**
   * Call this method to delete all files that
   * have been written to the memfs memory
   */
  clearMemory() {
    for (const t of [...new Set(this._memory)])
      this.deleteFile(t);
    this._memory = [];
  }
}
const S = {
  "lgpl-base": "https://unpkg.com/@diffusion-studio/ffmpeg-lgpl-base@0.0.1/dist/ffmpeg-core.js",
  "gpl-extended": "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js"
};
class O extends E {
  constructor(e = {}) {
    let s = console.log, i = S[(e == null ? void 0 : e.config) ?? "lgpl-base"];
    (e == null ? void 0 : e.log) == !1 && (s = _), e != null && e.source && (i = e.source);
    super({ logger: s, source: i });
    h(this, "_inputs", []);
    h(this, "_output");
    h(this, "_middleware", []);
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
    }, s = {
      video: JSON.parse(JSON.stringify(e)),
      audio: JSON.parse(JSON.stringify(e))
    }, i = (r) => {
      r = r.substring(7).replace(/\W{2,}/, " ").trim();
      const a = r.split(" "), c = a.shift() ?? "", n = a.join(" ");
      return { [c]: n };
    };
    return this.onMessage((r) => {
      r = r.trim();
      let a = [];
      if (r.match(/[DEVASIL\.]{6}\W(?!=)/)) {
        r.match(/^D.V/) && a.push(["video", "decoders"]), r.match(/^.EV/) && a.push(["video", "encoders"]), r.match(/^D.A/) && a.push(["audio", "decoders"]), r.match(/^.EA/) && a.push(["audio", "encoders"]);
        for (const [c, n] of a)
          Object.assign(s[c][n], i(r));
      }
    }), await this.exec(["-codecs"]), s;
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
    }, s = (i) => {
      i = i.substring(3).replace(/\W{2,}/, " ").trim();
      const r = i.split(" "), a = r.shift() ?? "", c = r.join(" ");
      return { [a]: c };
    };
    return this.onMessage((i) => {
      i = i.substring(1);
      let r = [];
      if (i.match(/[DE\.]{2}\W(?!=)/)) {
        i.match(/^D./) && r.push("demuxers"), i.match(/^.E/) && r.push("muxers");
        for (const a of r)
          Object.assign(e[a], s(i));
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
    const s = this.readFile(e.at(-1) ?? "");
    return this.clearMemory(), s;
  }
  /**
   * Get the meta data of a the specified file.
   * Returns information such as codecs, fps, bitrate etc.
   */
  async meta(e) {
    await this.writeFile("probe", e);
    const s = {
      streams: { audio: [], video: [] }
    }, i = F(s);
    return this.onMessage(i), await this.exec(["-i", "probe"]), this.removeOnMessage(i), this.clearMemory(), s;
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
  async *thumbnails(e, s = 5, i = 0, r) {
    if (!r) {
      const { duration: c } = await this.meta(e);
      c ? r = c : (console.warn(
        "Could not extract duration from meta data please provide a stop argument. Falling back to 1sec otherwise."
      ), r = 1);
    }
    const a = (r - i) / s;
    await this.writeFile("input", e);
    for (let c = i; c < r; c += a) {
      await this.exec([
        "-ss",
        c.toString(),
        "-i",
        "input",
        "-frames:v",
        "1",
        "image.jpg"
      ]);
      try {
        const n = await this.readFile("image.jpg");
        yield new Blob([n], { type: "image/jpeg" });
      } catch {
      }
    }
    this.clearMemory();
  }
  parseOutputOptions() {
    if (!this._output)
      throw new Error("Please define the output first");
    const { format: e, path: s, audio: i, video: r, seek: a, duration: c } = this._output, n = [];
    let m = `output.${e}`;
    return s && (m = s + m), a && n.push("-ss", a.toString()), c && n.push("-t", c.toString()), n.push(...this.parseAudioOutput(i)), n.push(...this.parseVideoOutput(r)), n.push(m), n;
  }
  parseAudioOutput(e) {
    if (!e)
      return [];
    if ("disableAudio" in e)
      return e.disableAudio ? ["-an"] : [];
    const s = [];
    return e.codec && s.push("-c:a", e.codec), e.bitrate && s.push("-b:a", e.bitrate.toString()), e.numberOfChannels && s.push("-ac", e.numberOfChannels.toString()), e.volume && s.push("-vol", e.volume.toString()), e.sampleRate && s.push("-ar", e.sampleRate.toString()), s;
  }
  parseVideoOutput(e) {
    if (!e)
      return [];
    if ("disableVideo" in e)
      return e.disableVideo ? ["-vn"] : [];
    const s = [];
    return e.codec && s.push("-c:v", e.codec), e.bitrate && s.push("-b:v", e.bitrate.toString()), e.aspectRatio && s.push("-aspect", e.aspectRatio.toString()), e.framerate && s.push("-r", e.framerate.toString()), e.size && s.push("-s", `${e.size.width}x${e.size.height}`), s;
  }
  async parseInputOptions() {
    const e = [];
    for (const s of this._inputs)
      e.push(...await this.parseImageInput(s)), e.push(...await this.parseMediaInput(s));
    return e;
  }
  async parseImageInput(e) {
    if (!("sequence" in e))
      return [];
    const s = e.sequence.length.toString().length, i = "image-sequence-";
    let r = `${i}%0${s}d`;
    const a = [];
    for (const [c, n] of e.sequence.entries())
      if (n instanceof Blob || n.match(/(^http(s?):\/\/|^\/\S)/)) {
        const m = `${i}${c.toString().padStart(c, "0")}`;
        await this.writeFile(m, n);
      } else {
        const m = n.match(/[0-9]{1,20}/);
        if (m) {
          const [u] = m;
          r = n.replace(/[0-9]{1,20}/, `%0${u.length}d`);
        }
      }
    return a.push("-framerate", e.framerate.toString()), a.push("-i", r), a;
  }
  async parseMediaInput(e) {
    if (!("source" in e))
      return [];
    const { source: s } = e, i = [], r = `input-${(/* @__PURE__ */ new Date()).getTime()}`;
    return e.seek && i.push("-ss", e.seek.toString()), s instanceof Blob || s.match(/(^http(s?):\/\/|^\/\S)/) ? (await this.writeFile(r, s), i.push("-i", r)) : i.push("-i", s), i;
  }
}
export {
  O as FFmpeg
};
