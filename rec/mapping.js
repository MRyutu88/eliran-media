// Tracking -> Eliran (docs/phone_recording.md, "Mapping").
// - Expressions: every MediaPipe blendshape whose name is also an expression in the VRM (ELIRAN18 has 22 custom
//   expressions with ARKit names: eyeBlink*, eyeLook*, jawOpen, mouthSmile*, brow*, ...) is driven by name. The list is
//   read from the model, so a model with more ARKit shapes gets them with no code change.
// - Head: rotation from the face transform, split between neck/head (+ a little spine), clamped.
// - "Mirror" (default on): the avatar moves like a reflection, so Left<->Right swap and yaw/roll flip.
//   MediaPipe works on the raw (non-mirrored) camera image; its face frame has +X = the person's left, the same as a
//   VRM 1.0 model facing +Z, so "not mirrored" = copy as is.
// - One Euro smoothing per channel; no face for LOST_MS -> ease back to neutral.
// - Head position (since version 5): the matrix translation (cm) minus a neutral position (the first detection, or
//   "כייל"), smoothed and clamped, in this.pos. It drives the body (body.js); this file writes only neck and head.
import * as THREE from "three";

const LOST_MS = 400;
const MAX_YAW = 40, MAX_PITCH = 30, MAX_ROLL = 30; // degrees
const SPLIT = { neck: 0.4, head: 0.6 }, SPINE = { yaw: 0.15, roll: 0.1 };
const MAX_POS = { x: 20, y: 20, z: 25 }; // cm from the neutral position

// Remap raw MediaPipe scores: [lo, hi] -> [0, 1]. MediaPipe rarely reaches 1 (a shut eye is ~0.6-0.8).
const RANGE = {
  eyeBlink: [0.22, 0.62], jawOpen: [0.04, 0.55], mouthSmile: [0.08, 0.65], mouthStretch: [0.05, 0.5],
  mouthFunnel: [0.05, 0.5], mouthPucker: [0.08, 0.7], eyeLook: [0.05, 0.7], browDown: [0.45, 0.95], brow: [0.08, 0.6],
};
// browDown sits at ~0.3-0.75 on a resting or smiling face (MediaPipe reads squinting as brows down), so it starts high.
const rangeFor = (n) => RANGE[Object.keys(RANGE).find((k) => n.startsWith(k))] ?? [0.05, 0.8];
// One Euro settings [minCutoff Hz, beta]: blink and mouth react fast, the head is calmer.
const FILTER = { eyeBlink: [4, 0.8], jawOpen: [3, 0.6], mouth: [2.5, 0.5], eyeLook: [2, 0.4], brow: [1.5, 0.3], head: [1.2, 0.25], pos: [1, 0.03] };
const filterFor = (n) => FILTER[Object.keys(FILTER).find((k) => n.startsWith(k))] ?? [2, 0.4];

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 }); }
  static a(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(v, tMs) {
    if (this.x === null) { this.x = v; this.t = tMs; return v; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
    const dx = (v - this.x) / dt;
    this.dx += OneEuro.a(this.dCutoff, dt) * (dx - this.dx);
    this.x += OneEuro.a(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
}

const swapSide = (n) => n.includes("Left") ? n.replace("Left", "Right") : n.includes("Right") ? n.replace("Right", "Left") : n;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const D2R = Math.PI / 180;

// The constants in effect, written into every performance file (take.js) so a later retune knows what was used.
// Version 2 (5): head position (pos, MAX_POS, FILTER.pos).
export const MAPPING = { version: 2, LOST_MS, MAX_YAW, MAX_PITCH, MAX_ROLL, SPLIT, SPINE, MAX_POS, RANGE, FILTER };

export class FaceRig {
  constructor(vrm) {
    this.vrm = vrm;
    this.mirror = true;
    this.names = new Set(Object.keys(vrm.expressionManager.expressionMap));
    this.filters = new Map();
    this.target = {};        // smoothed expression values
    this.head = { x: 0, y: 0, z: 0 };
    this.offset = { x: 0, y: 0, z: 0 }; // "כייל ראש"
    this.pos = { x: 0, y: 0, z: 0 };    // head position from neutral, cm (mirrored like yaw: +x = the avatar's left)
    this.offsetPos = null;              // neutral head position (raw cm); null = the next detection becomes neutral
    this.rawPos = null;
    this.lastSeen = 0;
    this.raw = null;         // last raw head euler, for calibration
    this.shapes = null;      // last raw blendshapes
    this.base = {};          // resting face from "כייל": each channel starts above its resting value
    const b = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    this.bones = { neck: b("neck"), head: b("head"), spine: b("spine") };
    this.driven = [...this.names].filter((n) => /^(eye|jaw|mouth|brow|cheek|nose|tongue)/.test(n));
  }

  f(name, v, t) {
    let fl = this.filters.get(name);
    if (!fl) { const [mc, beta] = filterFor(name); fl = new OneEuro(mc, beta); this.filters.set(name, fl); }
    return fl.filter(v, t);
  }

  // face: {shapes, matrix} from tracking.js, or null when no face was found in this frame.
  update(face, t) {
    if (!face) return;
    this.lastSeen = t;
    this.shapes = face.shapes;
    for (const [mpName, score] of Object.entries(face.shapes)) {
      const name = this.mirror ? swapSide(mpName) : mpName;
      if (!this.names.has(name)) continue;
      const [lo0, hi0] = rangeFor(mpName);
      const lo = Math.max(lo0, (this.base[mpName] ?? 0) + 0.04), hi = Math.max(hi0, lo + 0.2);
      this.target[name] = clamp(this.f(name, clamp((score - lo) / (hi - lo), 0, 1), t), 0, 1);
    }
    if (face.matrix) {
      const m = new THREE.Matrix4().fromArray(face.matrix);
      const e = new THREE.Euler().setFromRotationMatrix(m, "YXZ");
      this.raw = { x: e.x, y: e.y, z: e.z };
      const s = this.mirror ? -1 : 1;
      const x = clamp(e.x - this.offset.x, -MAX_PITCH * D2R, MAX_PITCH * D2R);
      const y = clamp(s * (e.y - this.offset.y), -MAX_YAW * D2R, MAX_YAW * D2R);
      const z = clamp(s * (e.z - this.offset.z), -MAX_ROLL * D2R, MAX_ROLL * D2R);
      this.head = { x: this.f("head.x", x, t), y: this.f("head.y", y, t), z: this.f("head.z", z, t) };
      const el = m.elements, rp = { x: el[12], y: el[13], z: el[14] };
      this.rawPos = rp;
      if (!this.offsetPos) this.offsetPos = { ...rp };
      const o = this.offsetPos;
      const px = clamp(s * (rp.x - o.x), -MAX_POS.x, MAX_POS.x);
      const py = clamp(rp.y - o.y, -MAX_POS.y, MAX_POS.y);
      const pz = clamp(rp.z - o.z, -MAX_POS.z, MAX_POS.z); // + = closer to the camera
      this.pos = { x: this.f("pos.x", px, t), y: this.f("pos.y", py, t), z: this.f("pos.z", pz, t) };
    }
  }

  // "כייל": the current head angle becomes straight, and the current face becomes the resting face.
  calibrate() {
    if (this.raw) this.offset = { ...this.raw };
    if (this.rawPos) this.offsetPos = { ...this.rawPos };
    if (this.shapes) this.base = { ...this.shapes };
  }

  // Full mapping state with times relative to t0, so a replay (take.js) can start from exactly where the live rig was
  // when the take began: One Euro state per channel, held values, head, calibration and mirror.
  snapshot(t0) {
    const filters = {};
    for (const [n, f] of this.filters) filters[n] = { x: f.x, dx: f.dx, t: f.t - t0 };
    return { mirror: this.mirror, offset: { ...this.offset }, base: { ...this.base }, target: { ...this.target },
             head: { ...this.head }, pos: { ...this.pos }, offsetPos: this.offsetPos && { ...this.offsetPos },
             lastSeen: this.lastSeen - t0, filters };
  }
  restore(s) {
    this.mirror = s.mirror; this.offset = { ...s.offset }; this.base = { ...s.base }; this.target = { ...s.target };
    this.head = { ...s.head }; this.lastSeen = s.lastSeen;
    // Takes before version 5 have no position: the first detection of the replay becomes neutral (as live would).
    this.pos = { x: 0, y: 0, z: 0, ...s.pos }; this.offsetPos = s.offsetPos ? { ...s.offsetPos } : null;
    this.filters = new Map();
    for (const [n, v] of Object.entries(s.filters || {})) {
      const [mc, beta] = filterFor(n), fl = new OneEuro(mc, beta);
      Object.assign(fl, { x: v.x, dx: v.dx, t: v.t });
      this.filters.set(n, fl);
    }
  }
  // Calibration from a recorded event (the values the live "כייל" stored).
  setCalibration(offset, base, offsetPos) {
    this.offset = { ...offset }; this.base = { ...base };
    if (offsetPos) this.offsetPos = { ...offsetPos };
  }

  // Every render frame: write the held values to the model (ease to neutral when the face is lost).
  apply(dt, t) {
    const lost = t - this.lastSeen > LOST_MS;
    const k = lost ? Math.exp(-dt * 4) : 1;
    const em = this.vrm.expressionManager;
    for (const n of this.driven) {
      const v = (this.target[n] ?? 0) * k;
      this.target[n] = v;
      em.setValue(n, v);
    }
    if (lost) for (const a of ["x", "y", "z"]) { this.head[a] *= k; this.pos[a] *= k; }
    this.writeBones();
  }
  // Head/neck/spine from this.head (body.js then overwrites the spine and adds to neck/head when its extras are on). Also used by the editor/offline render (take.js PoseTrack), which sets
  // this.target/this.head from the precomputed pose and writes the expressions itself.
  writeBones() {
    const { x, y, z } = this.head, { neck, head, spine } = this.bones;
    neck?.rotation.set(x * SPLIT.neck, y * SPLIT.neck, z * SPLIT.neck, "YXZ");
    head?.rotation.set(x * SPLIT.head, y * SPLIT.head, z * SPLIT.head, "YXZ");
    spine?.rotation.set(0, y * SPINE.yaw, z * SPINE.roll, "YXZ");
  }
}
