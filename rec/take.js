// Performance files ("take", docs/phone_recording.md, "Performance file"): everything needed to drive Eliran again
// exactly as in the live take, without the camera: per face detection the raw MediaPipe blendshapes + head matrix
// (before mapping, so mapping/smoothing can be retuned later), the render frame times, the mapping state at the start,
// the settings and their changes during the take, and the mic audio.
//
// Binary layout, version 1 (all numbers little-endian):
//   0   8 bytes  ASCII "ELIRANPF"
//   8   u32      format version (1)
//   12  u32      N = header length in bytes
//   16  N bytes  header, UTF-8 JSON (see writeTake); header.sections = [{name, offset, bytes}], offsets from file start
//   ... sections, each starting on an 8-byte boundary:
//       "detTime"  Float64[det.count]               detection time, ms since t0 (the take start)
//       "det"      Float32[det.count * det.stride]  per detection: flags (1 = face, 2 = matrix), shapes[header.shapes
//                                                   order], matrix[16] (MediaPipe facialTransformationMatrix, column-major)
//       "render"   Float64[render.count]            render frame times, ms since t0 (one video frame each)
//       "audio"    raw bytes of the mic recording (header.audio.type), when there was a mic
import { MAPPING } from "./mapping.js?v=5";
import { STEP_MS, OUT_LEN } from "./body.js?v=5";
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

const MAGIC = "ELIRANPF", VERSION = 1;
export const EXT = "eliperf";

// Collects a live take. now = the loop's rAF time (the same value given to rig.update).
export class TakeWriter {
  constructor(t0, rig, info) {
    this.t0 = t0;
    this.start = rig.snapshot(t0);
    this.info = info;
    this.frames = [];   // {t, shapes|null, matrix|null}
    this.render = [];
    this.events = [];
    this.shapeNames = null;
  }
  det(now, face) {
    const t = now - this.t0;
    if (face && !this.shapeNames) this.shapeNames = Object.keys(face.shapes);
    this.frames.push({ t, shapes: face?.shapes ?? null, matrix: face?.matrix ? Float32Array.from(face.matrix) : null });
  }
  frame(now) { this.render.push(now - this.t0); }
  // A setting changed during the take. It is placed right after the last detection so a replay applies it in the
  // same order as live (a click handler runs between two loop frames; its clock time can be earlier than the next
  // frame's rAF time). `at` keeps the real clock time.
  event(type, data) {
    const last = this.frames.length ? this.frames[this.frames.length - 1].t : this.start.lastSeen;
    this.events.push({ t: last + 0.001, at: performance.now() - this.t0, type, ...data });
  }

  // -> Blob of the whole file. rec = the recorder result ({video, audio, ms}).
  async finish(rec) {
    const names = this.shapeNames || [];
    const stride = 1 + names.length + 16, n = this.frames.length;
    const detTime = new Float64Array(n), det = new Float32Array(n * stride);
    this.frames.forEach((f, i) => {
      detTime[i] = f.t;
      const o = i * stride;
      det[o] = (f.shapes ? 1 : 0) | (f.matrix ? 2 : 0);
      if (f.shapes) names.forEach((k, j) => { det[o + 1 + j] = f.shapes[k] ?? 0; });
      if (f.matrix) det.set(f.matrix.subarray(0, 16), o + 1 + names.length);
    });
    const render = Float64Array.from(this.render);
    const audioBuf = rec.audio ? new Uint8Array(await rec.audio.blob.arrayBuffer()) : null;
    const header = {
      format: "eliran-performance", version: VERSION, created: new Date().toISOString(),
      timeBase: "ms since t0 = performance.now() when the take's recorders were started",
      durationMs: rec.ms,
      shapes: names,
      det: { count: n, stride, layout: "flags, shapes[shapes.length], matrix[16] column-major" },
      render: { count: render.length },
      start: this.start,                 // FaceRig.snapshot(t0): One Euro state, held values, head, calibration, mirror
      settings: this.info.settings,      // at the start: mirror, framing, calibration
      body: this.info.body,              // body.js settings while recording (for reference: replay/render use the current ones)
      events: this.events,               // [{t, at, type: "mirror"|"calib"|"frame", ...}]
      mapping: MAPPING,
      model: this.info.model,
      tracker: this.info.tracker,
      stage: this.info.stage,
      video: { type: rec.video.type, startMs: rec.video.startMs },
      audio: rec.audio ? { type: rec.audio.type, startMs: rec.audio.startMs, bytes: audioBuf.length } : null,
      page: "share_site/rec take v1",
    };
    const parts = [["detTime", detTime], ["det", det], ["render", render]];
    if (audioBuf) parts.push(["audio", audioBuf]);
    // The header carries the section offsets, which depend on the header length: compute until stable.
    let sections = [], hdr;
    for (let pass = 0; pass < 4; pass++) {
      hdr = new TextEncoder().encode(JSON.stringify({ ...header, sections }));
      let off = align8(16 + hdr.length);
      const next = parts.map(([name, arr]) => { const s = { name, offset: off, bytes: arr.byteLength }; off = align8(off + arr.byteLength); return s; });
      if (JSON.stringify(next) === JSON.stringify(sections)) break;
      sections = next;
    }
    const total = sections.length ? align8(sections.at(-1).offset + sections.at(-1).bytes) : align8(16 + hdr.length);
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) out[i] = MAGIC.charCodeAt(i);
    dv.setUint32(8, VERSION, true);
    dv.setUint32(12, hdr.length, true);
    out.set(hdr, 16);
    parts.forEach(([, arr], i) => out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), sections[i].offset));
    return new Blob([out], { type: "application/octet-stream" });
  }
}
const align8 = (x) => (x + 7) & ~7;

// Blob/ArrayBuffer -> {header, frames: [{t, face: {shapes, matrix} | null}], render: Float64Array, audio: Blob | null}
export async function readTake(src) {
  const buf = src instanceof ArrayBuffer ? src : await src.arrayBuffer();
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (String.fromCharCode(...u8.subarray(0, 8)) !== MAGIC) throw new Error("not-a-take");
  const version = dv.getUint32(8, true);
  if (version > VERSION) throw new Error("take-too-new");
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + dv.getUint32(12, true))));
  const sec = Object.fromEntries(header.sections.map((s) => [s.name, s]));
  const slice = (name) => buf.slice(sec[name].offset, sec[name].offset + sec[name].bytes); // copies, so aligned
  const detTime = new Float64Array(slice("detTime")), det = new Float32Array(slice("det"));
  const { stride } = header.det, names = header.shapes, frames = [];
  for (let i = 0; i < header.det.count; i++) {
    const o = i * stride, flags = det[o];
    let face = null;
    if (flags & 1) {
      const shapes = {};
      names.forEach((k, j) => { shapes[k] = det[o + 1 + j]; });
      face = { shapes, matrix: flags & 2 ? Array.from(det.subarray(o + 1 + names.length, o + 1 + names.length + 16)) : null };
    }
    frames.push({ t: detTime[i], face });
  }
  const render = new Float64Array(slice("render"));
  const audio = sec.audio ? new Blob([slice("audio")], { type: header.audio?.type || "audio/webm" }) : null;
  return { header, frames, render, audio };
}

// Drives a FaceRig from a take with the same calls as live: restore the start state, then rig.update(face, t) for each
// detection at its recorded time and the recorded setting changes in order. feed(tv) applies everything up to tv
// (ms since t0). Framing events are not applied: in replay the framing is the user's choice ("קרוב"/"מלא").
export function createReplay(take, rig, { onUpdate, onDet } = {}) {
  rig.restore(take.header.start);
  const items = [
    ...take.header.events.filter((e) => e.type !== "frame").map((e) => ({ ...e, kind: "event" })),
    ...take.frames.map((f) => ({ ...f, kind: "det" })),
  ].sort((a, b) => a.t - b.t || (a.kind === "event" ? -1 : 1));
  let i = 0;
  function feed(tv) {
    while (i < items.length && items[i].t <= tv) {
      const it = items[i++];
      if (it.kind === "det") { rig.update(it.face, it.t); if (it.face) onUpdate?.(it.t); onDet?.(it.t, !!it.face); }
      else if (it.type === "mirror") rig.mirror = it.value;
      else if (it.type === "calib") rig.setCalibration(it.offset, it.base, it.offsetPos);
    }
  }
  return { feed, durationMs: take.header.durationMs, get done() { return i >= items.length; } };
}

// The whole performance computed once, for the editor and the offline render (editor.js, render.js): the take is fed
// through createReplay (the same mapping as live and replay) and the rig's values are kept after every detection.
// at(t) then gives the pose at any time, in any order (scrubbing), with no per-frame state:
// - between two detections (both with a face, at most GAP_MS apart) the values are interpolated linearly, so a
//   60 fps render of ~40 detections/s moves smoothly instead of in steps;
// - a lost face eases to neutral like live (live multiplies by exp(-4 dt) every frame once LOST_MS passed since the
//   last face; here the same curve is computed from the time: exp(-4 (t - lastSeen - LOST_MS))).
// - the body (body.js) is a spring simulation, so it is run once over the whole take on its fixed 1/60 s grid (from a
//   settled start) and at(t) interpolates that grid: still stateless, and two renders give the same frames.
//   setBody() reruns it when the settings change (90 s = 5400 steps).
const GAP_MS = 120, SETTLE_STEPS = 120;
export class PoseTrack {
  // body = a BodyRig (body.js) or null.
  constructor(take, rig, body = null) {
    this.rig = rig;
    this.names = rig.driven;
    const n = this.names.length, rows = [];
    const keep = (t) => {
      const v = new Float32Array(n + 6);
      this.names.forEach((k, i) => { v[i] = rig.target[k] ?? 0; });
      v[n] = rig.head.x; v[n + 1] = rig.head.y; v[n + 2] = rig.head.z;
      v[n + 3] = rig.pos.x; v[n + 4] = rig.pos.y; v[n + 5] = rig.pos.z;
      rows.push({ t, seen: rig.lastSeen, v });
    };
    const replay = createReplay(take, rig, { onDet: (t) => keep(t) });
    keep(Math.min(0, take.frames[0]?.t ?? 0) - 1); // the start state (before the first detection)
    replay.feed(Infinity);
    rows.sort((a, b) => a.t - b.t);
    this.t = Float64Array.from(rows, (r) => r.t);
    this.seen = Float64Array.from(rows, (r) => r.seen);
    this.v = rows.map((r) => r.v);
    this.lostMs = take.header.mapping?.LOST_MS ?? 400;
    this.out = new Float32Array(n + 6);
    this.durationMs = take.header.durationMs;
    this.jaw = this.names.indexOf("jawOpen");
    this.body = body;
    this.buildBody();
  }
  // The body over the whole take, one output vector per 1/60 s step (grid[i] = time i * STEP_MS).
  buildBody() {
    const b = this.body;
    this.grid = null;
    if (!b) return;
    b.reset();
    const n = this.names.length, o = this.out;
    const inp = () => ({ hx: o[n], hy: o[n + 1], hz: o[n + 2], px: o[n + 3], py: o[n + 4], pz: o[n + 5], jaw: this.jaw >= 0 ? o[this.jaw] : 0 });
    this.sample(0);
    for (let i = SETTLE_STEPS; i > 0; i--) b.step(inp(), -i * STEP_MS);
    const steps = Math.ceil(Math.max(0, this.durationMs) / STEP_MS) + 2;
    this.grid = new Float32Array(steps * OUT_LEN);
    for (let i = 0; i < steps; i++) {
      this.sample(i * STEP_MS);
      b.step(inp(), i * STEP_MS);
      this.grid.set(b.out, i * OUT_LEN);
    }
    this.bodyOut = new Float32Array(OUT_LEN);
  }
  setBody(settings) { if (this.body) { this.body.settings = settings; this.buildBody(); } }
  // Index of the last row with t <= time (0 if none).
  find(time) {
    let lo = 0, hi = this.t.length - 1;
    if (time <= this.t[0]) return 0;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.t[mid] <= time) lo = mid; else hi = mid - 1; }
    return lo;
  }
  // Sets the rig's target/head to the pose at time t (ms since t0) and writes it (and the body) to the model.
  at(time) {
    this.sample(time);
    const out = this.out, n = this.names.length;
    const rig = this.rig, em = rig.vrm.expressionManager;
    this.names.forEach((name, c) => { rig.target[name] = out[c]; em.setValue(name, out[c]); });
    rig.head = { x: out[n], y: out[n + 1], z: out[n + 2] };
    rig.pos = { x: out[n + 3], y: out[n + 4], z: out[n + 5] };
    rig.writeBones();
    if (this.grid) {
      const steps = this.grid.length / OUT_LEN, f = clampN(time / STEP_MS, 0, steps - 1), i = Math.min(steps - 2, Math.floor(f)), w = f - i;
      const g = this.grid, bo = this.bodyOut, a = i * OUT_LEN, c = a + OUT_LEN;
      for (let k = 0; k < OUT_LEN; k++) bo[k] = g[a + k] + (g[c + k] - g[a + k]) * w;
      this.body.write(bo);
    }
  }
  // The pose at time t into this.out (no writing).
  sample(time) {
    const i = this.find(time), a = this.v[i], out = this.out;
    const lost = time - this.seen[i] - this.lostMs;
    const k = lost > 0 ? Math.exp(-4 * lost / 1000) : 1;
    const j = i + 1;
    const blend = j < this.t.length && this.seen[j] === this.t[j] && this.t[j] - this.t[i] <= GAP_MS && time > this.t[i];
    if (blend) {
      const f = (time - this.t[i]) / (this.t[j] - this.t[i]), b = this.v[j];
      for (let c = 0; c < out.length; c++) out[c] = a[c] * k + (b[c] - a[c] * k) * f;
    } else for (let c = 0; c < out.length; c++) out[c] = a[c] * k;
  }
}
