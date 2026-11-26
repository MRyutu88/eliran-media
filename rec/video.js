// Background video for the editor and the offline render (docs/phone_recording.md, "Background video", version 8).
// The file is the user's own, picked from the phone and kept in IndexedDB only ("media:<id>"). No transcoding:
// mp4box.js reads only the moov (the sample table; a moov at the end of the file does not need the whole file in
// memory), the sample bytes are read from the Blob by offset in ~4 MB windows, and WebCodecs VideoDecoder decodes.
// frameAt(ms) gives the exact frame shown at that time (decoding from the keyframe before it when it has to jump;
// going forward keeps the decoder running, as in playback and the render). After the last frame: the last frame.
// The track's rotation matrix (phone portrait videos are stored rotated) is applied when the frame is drawn (drawVideo).
// The sound: audioOf() decodes the file's audio track (decodeAudioData) for mixAudio (the editor and the render).

const WINDOW = 4 << 20; // bytes read from the Blob at a time
const MAX_SIDE_OK = 1920; // up to 1080p (either orientation) is normal; larger only when the decoder supports it
let MP4 = null;
const mp4box = async () => (MP4 ??= await import("mp4box"));

export const supported = () => typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";

// The rotation in the track matrix, in degrees clockwise on screen (0, 90, 180, 270).
function rotationOf(m) {
  if (!m || m.length < 4) return 0;
  const deg = Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI / 90) * 90;
  return ((deg % 360) + 360) % 360;
}

// The decoder's "description" (avcC / hvcC / vpcC / av1C without the box header).
function descriptionOf(MP4Box, trak) {
  for (const e of trak.mdia.minf.stbl.stsd.entries) {
    const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
    if (box) {
      const s = new MP4Box.DataStream(undefined, 0, MP4Box.Endianness.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer, 8);
    }
  }
  return undefined;
}

// Reads the moov of blob. -> {info, trak} or throws Error("not-mp4" | "no-video").
async function parse(blob) {
  const MP4Box = await mp4box();
  const file = MP4Box.createFile();
  let info = null, fail = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { fail = e; };
  let pos = 0, guard = 0;
  while (!info && !fail && pos < blob.size && guard++ < 10000) {
    const ab = await blob.slice(pos, Math.min(blob.size, pos + WINDOW)).arrayBuffer();
    const next = file.appendBuffer(MP4Box.MP4BoxBuffer.fromArrayBuffer(ab, pos), pos + ab.byteLength >= blob.size);
    pos = typeof next === "number" && next > pos ? next : pos + ab.byteLength;
  }
  if (!info) throw new Error("not-mp4");
  const track = info.videoTracks?.[0];
  if (!track) throw new Error("no-video");
  return { MP4Box, file, info, track, trak: file.getTrackById(track.id) };
}

export class VideoSource {
  // -> VideoSource (throws Error "not-mp4" | "no-video" | "no-decoder" | "codec:<codec>" | "too-big")
  static async open(blob) {
    if (!supported()) throw new Error("no-decoder");
    const { MP4Box, info, track, trak } = await parse(blob);
    const raw = trak.samples || [];
    if (!raw.length) throw new Error("no-video");
    const ts = raw[0].timescale || track.timescale;
    const minCts = Math.min(...raw.map((s) => s.cts));
    const samples = raw.map((s, i) => ({ i, offset: s.offset, size: s.size, key: !!s.is_sync,
      ms: ((s.cts - minCts) * 1000) / ts, durMs: (s.duration * 1000) / ts }));
    samples[0].key = true; // decoding always starts here
    const cw = track.video?.width || track.track_width, ch = track.video?.height || track.track_height;
    const cfg = { codec: track.codec, codedWidth: cw, codedHeight: ch, description: descriptionOf(MP4Box, trak),
                  optimizeForLatency: true };
    let sup = null;
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
      try { const r = await VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration }); if (r.supported) { sup = { ...cfg, hardwareAcceleration }; break; } }
      catch { /* next */ }
    }
    if (!sup) throw new Error("codec:" + track.codec);
    const rot = rotationOf(track.matrix);
    const pres = [...samples].sort((a, b) => a.ms - b.ms);
    const last = pres[pres.length - 1];
    const v = new VideoSource();
    Object.assign(v, {
      blob, cfg: sup, samples, pres, rot,
      w: rot % 180 ? ch : cw, h: rot % 180 ? cw : ch, // as shown
      ms: last.ms + (last.durMs || 0),
      fps: samples.length > 1 ? Math.round((1000 * samples.length) / Math.max(1, last.ms + last.durMs) * 100) / 100 : 0,
      codec: track.codec, audio: (info.audioTracks?.length || 0) > 0, big: Math.max(cw, ch) > MAX_SIDE_OK && Math.min(cw, ch) > 1088,
      hdr: false,
    });
    return v;
  }

  constructor() {
    this.dec = null; this.fed = 0; this.needKey = true; this.out = []; this.cur = null; this.err = null;
    this.win = null; this.lock = Promise.resolve(); this.wanted = null; this.busy = false; this.waiters = [];
    this.target = -1;
  }

  // the index in presentation order of the frame shown at ms (frozen on the last one after the end)
  presAt(ms) {
    const p = this.pres;
    let lo = 0, hi = p.length - 1;
    if (ms <= p[0].ms) return 0;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (p[mid].ms <= ms + 0.5) lo = mid; else hi = mid - 1; }
    return lo;
  }

  _decoder() {
    this.dec?.state !== "closed" && this.dec?.close?.();
    this.dec = new VideoDecoder({
      output: (f) => this._output(f),
      error: (e) => { this.err = e; this._wake(); },
    });
    this.dec.configure(this.cfg);
    this.dec.addEventListener?.("dequeue", () => this._wake());
    this.fed = 0; this.needKey = true;
    for (const f of this.out) f.close();
    this.out = [];
  }
  _output(f) {
    if (f.timestamp < this.target && f.timestamp !== this.cur?.timestamp) { f.close(); this._wake(); return; } // behind: not needed
    if (this.cur === null && !this.hdrChecked) { this.hdrChecked = true; this.hdr = ["pq", "hlg"].includes(f.colorSpace?.transfer); }
    this.out.push(f);
    this.out.sort((a, b) => a.timestamp - b.timestamp);
    this._wake();
  }
  _wake() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  _wait(ms) { return new Promise((r) => { const t = setTimeout(r, ms); this.waiters.push(() => { clearTimeout(t); r(); }); }); }

  async _bytes(s) {
    const w = this.win;
    if (!w || s.offset < w.start || s.offset + s.size > w.start + w.buf.byteLength) {
      const start = s.offset, end = Math.min(this.blob.size, start + Math.max(WINDOW, s.size));
      this.win = { start, buf: new Uint8Array(await this.blob.slice(start, end).arrayBuffer()) };
    }
    return this.win.buf.subarray(s.offset - this.win.start, s.offset - this.win.start + s.size);
  }
  async _feed() {
    const s = this.samples[this.fed++];
    const data = await this._bytes(s);
    this.dec.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: Math.round(s.ms * 1000), duration: Math.round(s.durMs * 1000), data }));
    this.needKey = false;
  }

  // The exact frame shown at ms (a VideoFrame owned by the source: valid until the next frameAt; do not close it).
  frameAt(ms) {
    const run = this.lock.then(() => this._frameAt(ms));
    this.lock = run.catch(() => {});
    return run;
  }
  async _frameAt(ms) {
    if (this.err) throw this.err;
    const p = this.pres[this.presAt(ms)], ts = Math.round(p.ms * 1000);
    if (this.cur && this.cur.timestamp === ts) return this.cur;
    // the keyframe this frame decodes from (decode order)
    let k = p.i;
    while (k > 0 && !this.samples[k].key) k--;
    const have = this.out.some((f) => f.timestamp === ts);
    const behind = this.cur && ts < this.cur.timestamp && !have;
    // start again from the keyframe when there is no running decoder, when going back, or when the frame is in a later
    // GOP than what was fed (skipping ahead is cheaper than decoding everything between)
    if (!this.dec || this.dec.state === "closed" || this.flushed || behind || (k > this.fed && !have)) {
      this._decoder();
      this.flushed = false;
      this.fed = k;
    }
    this.target = ts;
    for (const f of this.out.filter((f) => f.timestamp < ts)) f.close();
    this.out = this.out.filter((f) => f.timestamp >= ts);
    for (let spins = 0; ; spins++) {
      if (this.err) throw this.err;
      const hit = this.out.find((f) => f.timestamp === ts) || (this.out.length > 6 ? this.out[0] : null);
      if (hit) {
        if (this.cur && this.cur !== hit) this.cur.close();
        this.cur = hit;
        this.out = this.out.filter((f) => f !== hit);
        return hit;
      }
      if (this.fed <= p.i) { await this._feed(); continue; }
      // the decoder still works on what it has: wait for it (an output or the queue moving wakes us)
      if (this.dec.decodeQueueSize > 0) { await this._wait(20); continue; }
      // it holds the frame back for reordering (B-frames): give it the next chunks
      if (this.fed < this.samples.length && this.fed <= p.i + 32) { await this._feed(); await this._wait(spins > 40 ? 5 : 0); continue; }
      if (!this.flushed) { await this.dec.flush(); this.flushed = true; continue; } // the end of the file (or a stuck decoder)
      // nothing more will come: the closest frame we have
      const near = this.out[0] || this.cur;
      if (near && near !== this.cur) { this.cur?.close(); this.cur = near; this.out = this.out.filter((f) => f !== near); }
      if (!near) throw new Error("no-frame");
      return near;
    }
  }

  // The editor preview: ask for the frame at ms without waiting (one request in flight, the latest wins).
  want(ms) {
    this.wanted = ms;
    if (this.busy) return;
    this.busy = true;
    (async () => {
      while (this.wanted !== null) {
        const t = this.wanted; this.wanted = null;
        try { await this.frameAt(t); } catch (e) { console.warn("video frame", e); break; }
      }
      this.busy = false;
    })();
  }

  close() {
    try { if (this.dec && this.dec.state !== "closed") this.dec.close(); } catch { /* closed */ }
    for (const f of this.out) f.close();
    this.cur?.close();
    this.out = []; this.cur = null; this.dec = null; this.win = null;
  }
}

// Draws frame (rotated by rot degrees clockwise) into the box (x, y, w, h) in the shown orientation.
export function drawVideo(g, frame, rot, x, y, w, h) {
  if (!frame) return;
  if (!rot) { g.drawImage(frame, x, y, w, h); return; }
  g.save();
  g.translate(x + w / 2, y + h / 2);
  g.rotate((rot * Math.PI) / 180);
  const [dw, dh] = rot % 180 ? [h, w] : [w, h];
  g.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
  g.restore();
}

// The video's sound, decoded and resampled to sampleRate (null when it has none or it cannot be decoded).
export async function audioOf(blob, sampleRate) {
  try {
    const ac = new OfflineAudioContext(2, 1, sampleRate);
    return await ac.decodeAudioData(await blob.arrayBuffer());
  } catch (e) { console.warn("video audio", e); return null; }
}
