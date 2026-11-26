// The body around the head (docs/phone_recording.md, "Body and squash"): everything the page adds on top of the face
// tracking, each part with its own switch and strength in "⚙ הגדרות". Ideas and default sizes from the user's Warudo
// scene (MediaPipe Tracker body rotation/movement, the "Body Lean" and "Arm Movements" pendulums, the "Eliran Bounce"
// blueprint):
// - follow: spine + chest follow the head rotation on a spring (a moment late, a little overshoot); the neck takes
//   back 75% so the face still points where the head does (Warudo: body rotation 0.54 x (0.5, 1, 0.5), spine 0.5,
//   chest 0.25, neck compensation 0.75).
// - lean: head position. Closer to the camera bends the spine forward and the neck/head back (Body Lean: spine +45°,
//   neck -15°, head -40° per unit of 5 x metres, 0.4 s smoothing); sideways/up-down moves the body 0.28 of the head
//   (body movement 0.14 x head movement 2) and tilts the spine.
// - squash: the head's vertical speed (nod, up/down) drives a jelly spring on the body scale (volume kept).
// - talk: Eliran Bounce. While jawOpen > 0.3, a squash kick at most every 0.5 s into the same spring.
// - breath: a slow 1.5% scale and a little chest rotation.
// - arms: the arms hang on springs: they swing behind the body's roll and sideways movement and flap out on a squash.
// It runs on a fixed 1/60 s step, so it acts the same at any frame rate and the editor/offline render can compute it
// over a whole take (take.js PoseTrack) with the same code. Write order every frame: FaceRig.writeBones() (neck/head),
// then BodyRig.write() (overwrites the spine, adds to neck/head, sets chest/arms and the model's offset/scale).
import { ARM_DOWN, ELBOW } from "./avatar.js?v=8";

export const STEP_MS = 1000 / 60;
const DT = STEP_MS / 1000, TAU = Math.PI * 2, D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---- settings ("⚙ הגדרות", kept in localStorage) --------------------------------------------------------------
const KEY = "eliran-rec-body";
export const DEFAULTS = {
  version: 1,
  follow: { on: true, amt: 1, lag: 1, invert: false },
  lean: { on: true, amt: 1 },
  squash: { on: true, amt: 1, wobble: 1 },
  talk: { on: true, amt: 1 },
  breath: { on: true, amt: 1 },
  arms: { on: true, amt: 1 },
};
// What the settings sheet shows: per group a title, a line, sliders [key, label, min, max, step] and switches.
export const GROUPS = [
  { key: "follow", name: "הגוף עוקב אחרי הראש", hint: "הגב והחזה מסתובבים עם הראש, רגע אחריו",
    sliders: [["amt", "עוצמה", 0, 2, 0.05], ["lag", "איחור", 0.3, 2, 0.05]], switches: [["invert", "הפוך (הגוף נגד הראש)"]] },
  { key: "lean", name: "הטיה עם הראש", hint: "מתקרבים למצלמה: אלירן נשען קדימה. זזים הצידה: הגוף זז איתכם",
    sliders: [["amt", "עוצמה", 0, 2, 0.05]] },
  { key: "squash", name: "סקווש ומתיחה", hint: "הנהון או תנועה מהירה למעלה ולמטה: הגוף נמעך ונמתח כמו ג'לי",
    sliders: [["amt", "עוצמה", 0, 2, 0.05], ["wobble", "רטט", 0, 2, 0.05]] },
  { key: "talk", name: "קפיצה בדיבור", hint: "כשהפה נפתח: קפיצה קטנה (כמו Eliran Bounce)", sliders: [["amt", "עוצמה", 0, 2, 0.05]] },
  { key: "breath", name: "נשימה", hint: "הגוף מתרחב ומתכווץ לאט", sliders: [["amt", "עוצמה", 0, 2, 0.05]] },
  { key: "arms", name: "ידיים מתנדנדות", hint: "הידיים נגררות אחרי הגוף ונפתחות בסקווש", sliders: [["amt", "עוצמה", 0, 2, 0.05]] },
];
const clone = (o) => JSON.parse(JSON.stringify(o));
// Unknown or wrong-typed values fall back to the default, so an old or broken entry can never break the page.
export function checkSettings(s) {
  const out = clone(DEFAULTS);
  if (!s || typeof s !== "object") return out;
  for (const g of Object.keys(DEFAULTS)) {
    if (g === "version" || !s[g] || typeof s[g] !== "object") continue;
    for (const [k, v] of Object.entries(DEFAULTS[g])) if (typeof s[g][k] === typeof v && (typeof v !== "number" || isFinite(s[g][k]))) out[g][k] = s[g][k];
  }
  return out;
}
export function loadSettings() {
  try { return checkSettings(JSON.parse(localStorage.getItem(KEY))); } catch { return clone(DEFAULTS); }
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

// ---- the rig ---------------------------------------------------------------------------------------------------
class Spring {
  constructor() { this.x = 0; this.v = 0; }
  // Damped spring toward target (w = rad/s, z = damping ratio), plus an extra acceleration.
  step(target, w, z, acc = 0) {
    this.v += (w * w * (target - this.x) - 2 * z * w * this.v + acc) * DT;
    this.x += this.v * DT;
  }
}

// Output layout (one Float32Array, so PoseTrack can keep and interpolate it per step).
const O = { sp: 0, ch: 3, nk: 6, hd: 9, lUA: 12, lLA: 13, lH: 14, rUA: 15, rLA: 16, rH: 17, x: 18, y: 19, sx: 20, sy: 21 };
export const OUT_LEN = 22;

export class BodyRig {
  // stage = createStage() (for setBody); settings = a settings object (read every step, so changes apply at once).
  constructor(vrm, stage, settings) {
    this.vrm = vrm; this.stage = stage; this.settings = settings;
    const b = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    this.bones = {
      spine: b("spine"), chest: b("chest") || b("upperChest"), neck: b("neck"), head: b("head"),
      lUA: b("leftUpperArm"), lLA: b("leftLowerArm"), lH: b("leftHand"),
      rUA: b("rightUpperArm"), rLA: b("rightLowerArm"), rH: b("rightHand"),
    };
    this.out = new Float32Array(OUT_LEN);
    this.reset();
  }
  reset() {
    this.s = { bx: new Spring(), by: new Spring(), bz: new Spring(), lean: new Spring(), mx: new Spring(), my: new Spring(),
               q: new Spring(), swing: new Spring(), flap: new Spring() };
    this.prev = null; this.lastKick = -1e9; this.t = null; this.prevRoll = undefined; this.prevMx = undefined;
    this.out.fill(0); this.out[O.sx] = this.out[O.sy] = 1;
  }

  // Live / replay: advance to time tMs (ms, any clock) in fixed steps. inp = BodyRig.input(rig).
  update(inp, tMs) {
    if (this.t === null || tMs - this.t > 500 || tMs < this.t) { this.t = tMs - STEP_MS; this.prev = null; }
    while (this.t + STEP_MS <= tMs + 1e-6) { this.t += STEP_MS; this.step(inp, this.t); }
  }
  // What the rig reads from a FaceRig: head rotation (rad), head position (cm from neutral), jaw.
  static input(rig) {
    return { hx: rig.head.x, hy: rig.head.y, hz: rig.head.z, px: rig.pos?.x ?? 0, py: rig.pos?.y ?? 0, pz: rig.pos?.z ?? 0,
             jaw: rig.target.jawOpen ?? 0 };
  }

  // One fixed step at time t (ms).
  step(inp, t) {
    const S = this.settings, s = this.s, o = this.out;
    const p = this.prev || inp;
    this.prev = { ...inp };
    const vx = (inp.hx - p.hx) / DT, vy = (inp.py - p.py) / DT; // pitch speed (rad/s, + = looking down), up speed (cm/s)

    // follow: the body turns after the head
    const F = S.follow, fk = F.on ? F.amt * (F.invert ? -1 : 1) : 0;
    const wF = TAU * 2.2 / clamp(F.lag, 0.2, 3);
    s.bx.step(inp.hx * 0.27 * fk, wF, 0.45);
    s.by.step(inp.hy * 0.54 * fk, wF, 0.45);
    s.bz.step(inp.hz * 0.27 * fk, wF, 0.45);

    // lean: head position
    const L = S.lean, lk = L.on ? L.amt : 0;
    s.lean.step(clamp(inp.pz / 100 * 5, -0.1, 1.5) * lk, TAU * 1.2, 0.8); // forward up to 1.5 (Warudo), back only a little
    s.mx.step(inp.px / 100 * 0.28 * lk, TAU * 1.6, 0.6);
    s.my.step(inp.py / 100 * 0.28 * lk, TAU * 1.6, 0.6);

    // squash: jelly spring on the body height, pushed by vertical head speed, talk kicks
    const Q = S.squash, qk = Q.on ? Q.amt : 0;
    const zq = clamp(0.5 - 0.17 * Q.wobble, 0.08, 0.8);
    let kick = 0;
    const T = S.talk;
    if (T.on && inp.jaw > 0.3 && t - this.lastKick >= 500) { kick = -2 * T.amt / DT; this.lastKick = t; }
    s.q.step(0, TAU * 3.2, zq, -(5 * vx + 0.4 * vy) * qk + kick);
    s.q.x = clamp(s.q.x, -0.25, 0.25);

    // breath
    const B = S.breath, bk = B.on ? B.amt : 0, ph = Math.sin(TAU * t / 3200);
    const qb = 0.015 * bk * ph;

    // arms: swing behind the body's roll and sideways movement, flap out on a squash
    const A = S.arms, ak = A.on ? A.amt : 0;
    const roll = s.bz.x + (-inp.px * 0.012 * lk);
    const dRoll = this.prevRoll === undefined ? 0 : (roll - this.prevRoll) / DT;
    const dMx = this.prevMx === undefined ? 0 : (s.mx.x - this.prevMx) / DT;
    this.prevRoll = roll; this.prevMx = s.mx.x;
    s.swing.step(0, TAU * 1.6, 0.22, -(14 * dRoll + 48 * dMx) * ak);
    s.swing.x = clamp(s.swing.x, -0.6, 0.6);
    s.flap.step(clamp(-s.q.x * 2, -0.3, 0.5) * ak, TAU * 2.2, 0.3);

    // ---- outputs
    const comp = 0.75;
    const bx = s.bx.x, by = s.by.x, bz = s.bz.x, lean = s.lean.x;
    const side = -inp.px * 0.012 * lk; // tilt toward the side the head moved to
    if (F.on) { o[O.sp] = bx * 2 / 3; o[O.sp + 1] = by * 2 / 3; o[O.sp + 2] = bz * 2 / 3; }
    else { o[O.sp] = 0; o[O.sp + 1] = inp.hy * 0.15; o[O.sp + 2] = inp.hz * 0.1; } // the version 4 spine
    o[O.sp] += lean * 45 * D2R;
    o[O.sp + 2] += side;
    o[O.ch] = (F.on ? bx / 3 : 0) - 0.02 * bk * ph; o[O.ch + 1] = F.on ? by / 3 : 0; o[O.ch + 2] = F.on ? bz / 3 : 0;
    // the neck gives back most of the body turn and the lean, so the face keeps looking where the head looks
    o[O.nk] = -comp * (F.on ? bx : 0) - lean * 15 * D2R; o[O.nk + 1] = -comp * (F.on ? by : 0);
    o[O.nk + 2] = -comp * (F.on ? bz : 0) - side * comp;
    o[O.hd] = -lean * 40 * D2R; o[O.hd + 1] = 0; o[O.hd + 2] = 0;
    const sw = s.swing.x, fl = s.flap.x;
    o[O.lUA] = -ARM_DOWN + sw + fl; o[O.lLA] = -ELBOW + sw * 0.5 + fl * 0.3; o[O.lH] = sw * 1.2;
    o[O.rUA] = ARM_DOWN + sw - fl; o[O.rLA] = ELBOW + sw * 0.5 - fl * 0.3; o[O.rH] = sw * 1.2;
    o[O.x] = s.mx.x; o[O.y] = s.my.x;
    const sy = 1 + s.q.x + qb; // head-speed pushes are scaled by the squash strength, talk kicks by the talk strength
    o[O.sy] = sy; o[O.sx] = 1 / Math.sqrt(sy);
  }

  // Writes an output vector (this.out, or one from PoseTrack) to the model. Call right after FaceRig.writeBones().
  write(o = this.out) {
    const b = this.bones;
    b.spine?.rotation.set(o[O.sp], o[O.sp + 1], o[O.sp + 2], "YXZ");
    b.chest?.rotation.set(o[O.ch], o[O.ch + 1], o[O.ch + 2], "YXZ");
    if (b.neck) { b.neck.rotation.x += o[O.nk]; b.neck.rotation.y += o[O.nk + 1]; b.neck.rotation.z += o[O.nk + 2]; }
    if (b.head) b.head.rotation.x += o[O.hd];
    b.lUA && (b.lUA.rotation.z = o[O.lUA]); b.lLA && (b.lLA.rotation.z = o[O.lLA]); b.lH && (b.lH.rotation.z = o[O.lH]);
    b.rUA && (b.rUA.rotation.z = o[O.rUA]); b.rLA && (b.rLA.rotation.z = o[O.rLA]); b.rH && (b.rH.rotation.z = o[O.rH]);
    this.stage.setBody({ x: o[O.x], y: o[O.y], sx: o[O.sx], sy: o[O.sy] });
  }
}

// ---- presets ("פריסטים" at the top of "🕺 תנועה", kept in localStorage; "ייצא" / "ייבא" a JSON file as a backup) ----
// {version: 1, active: name | null, list: [{name, at, body}]}. active = the preset last applied or saved; the sheet
// marks it changed ("•") when the current settings differ from it.
const PKEY = "eliran-rec-presets";
export const PRESET_FILE = "eliran-rec-presets";
export function checkPresets(p) {
  const out = { version: 1, active: null, list: [] };
  if (!p || typeof p !== "object" || !Array.isArray(p.list)) return out;
  for (const x of p.list) {
    if (!x || typeof x.name !== "string" || !x.name.trim()) continue;
    const name = x.name.trim().slice(0, 40);
    if (out.list.some((y) => y.name === name)) continue;
    out.list.push({ name, at: Number(x.at) || Date.now(), body: checkSettings(x.body) });
  }
  out.active = out.list.some((y) => y.name === p.active) ? p.active : null;
  return out;
}
export function loadPresets() { try { return checkPresets(JSON.parse(localStorage.getItem(PKEY))); } catch { return checkPresets(null); } }
export function savePresets(p) { try { localStorage.setItem(PKEY, JSON.stringify(p)); return true; } catch { return false; } }
export const sameSettings = (a, b) => JSON.stringify(checkSettings(a)) === JSON.stringify(checkSettings(b));
