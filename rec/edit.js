// The edit on a take (docs/phone_recording.md, "Editor"): camera keys, effects and background changes on a timeline.
// Plain data, saved with the take in IndexedDB (take.edit); the editor (editor.js) changes it and the offline render
// (render.js) reads it. Every time is in ms on the take's clock (0 = the take start, the same t as the performance file).
//
// Format "eliran-edit", version 1:
//   { format, version: 1, updated,
//     cam0:    {shot, zoom, panX, panY}       the camera before the first key (default: the take's framing)
//     camera:  [{id, t, shot: "body"|"close", zoom, panX, panY, move, ease}]
//              from t the camera moves to this view over `move` ms (0 = cut), ease "smooth" (in-out) or "linear".
//              zoom 1 = the shot as is (2 = twice as close); panX/panY = shift as a fraction of the frame (+ = right/up).
//     effects: [{id, t, dur, type, dir?, strength}]
//              type "punch" (quick zoom in and back), "bounce" (hops, with squash), "spin" (turn around),
//              "enter" / "exit" (dir "right" | "left" | "down" | "pop"); after an exit Eliran stays out of frame until
//              the next enter, and before a first enter he is out. strength 0.5 | 1 | 1.5.
//     bg0:     "#rrggbb"                       the background before the first change
//     bg:      [{id, t, color, fade}]         from t the background turns to color over `fade` ms (0 = cut) }
// A new optional field = same version; a changed meaning = version 2 (readers refuse newer versions).
import { BG } from "./avatar.js?v=4";

export const EDIT_VERSION = 1;

// Background colors: the brand palette (templates/brand.css) first, then green for keying.
export const COLORS = [
  { name: "סגול כהה", color: BG }, { name: "שזיף", color: "#5B2140" }, { name: "דיו", color: "#16101C" },
  { name: "פטל", color: "#E8456B" }, { name: "אפרסק", color: "#F6B48A" }, { name: "קרם", color: "#FFF6EE" },
  { name: "צהוב", color: "#FFD23F" }, { name: "טורקיז", color: "#3DD9C9" }, { name: "סגול", color: "#C77DFF" },
  { name: "ירוק ליים", color: "#A6E35A" }, { name: "ורוד", color: "#FF8FCF" }, { name: "ירוק מפתח", color: "#00B140" },
];
export const EFFECTS = {
  punch: { name: "זום פאנץ'", dur: 600 }, bounce: { name: "קפיצה", dur: 900 }, spin: { name: "סיבוב", dur: 800 },
  enter: { name: "כניסה", dur: 600 }, exit: { name: "יציאה", dur: 600 },
};
export const DIRS = { right: "מימין", left: "משמאל", down: "מלמטה", pop: "צץ" };
export const SHOTS = { body: "מלא", close: "קרוב" };

let seq = 0;
export const newId = () => Date.now().toString(36) + (seq++).toString(36);

export function newEdit(take) {
  const shot = take?.header?.settings?.framing === "close" ? "close" : "body";
  return { format: "eliran-edit", version: EDIT_VERSION, updated: Date.now(),
           cam0: { shot, zoom: 1, panX: 0, panY: 0 }, camera: [], effects: [], bg0: BG, bg: [] };
}
export function checkEdit(e) {
  if (!e || e.format !== "eliran-edit") return null;
  if (e.version > EDIT_VERSION) throw new Error("edit-too-new");
  return e;
}
export const isEmpty = (e) => !e.camera.length && !e.effects.length && !e.bg.length;

// ---- easing -------------------------------------------------------------------------------------------------
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const inCubic = (x) => x * x * x;
const outBack = (x) => { const c = 1.6; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const sorted = (list) => [...list].sort((a, b) => a.t - b.t);

// ---- camera -------------------------------------------------------------------------------------------------
// A view {x, y, dist, z} for the stage (avatar.js view()). shots = stage.shots (measured on the rest pose).
const TAN = Math.tan((28 / 2) * Math.PI / 180); // the stage camera's vertical half-angle (fov 28)
function viewOf(k, shots) {
  const s = shots[k.shot] || shots.body, dist = s.dist / Math.max(0.2, k.zoom || 1);
  const h = 2 * dist * TAN, w = h * 9 / 16;
  return { x: (k.panX || 0) * w, y: s.y + (k.panY || 0) * h, dist, z: s.z };
}
function mix(a, b, f) {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
           dist: Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * f) }; // zoom feels even in log
}
export function cameraAt(edit, t, shots) {
  let cur = viewOf(edit.cam0, shots);
  for (const k of sorted(edit.camera)) {
    if (k.t > t) break;
    const target = viewOf(k, shots), p = k.move > 0 ? clamp01((t - k.t) / k.move) : 1;
    cur = mix(cur, target, k.ease === "linear" ? p : inOut(p));
  }
  return cur;
}

// ---- effects ------------------------------------------------------------------------------------------------
// -> {fx: {x, y, rotY, sx, sy, hidden} for stage.place(), zoom: camera distance factor (punch)}.
// size = stage.size (model width/height in m); side = how far "out of frame" is to the side (from the body shot).
function inOutState(effects, t) {
  // Out of frame at t? = after an exit that ended with no enter since, or before a first enter.
  const io = sorted(effects.filter((e) => e.type === "enter" || e.type === "exit"));
  let last = null;
  for (const e of io) { if (e.t <= t) last = e; else break; }
  if (!last) return io[0]?.type === "enter" ? io[0] : null;
  return last.type === "exit" && t >= last.t + last.dur ? last : null;
}
function away(dir, q, size, side) {
  // q = 1 fully away, 0 in place.
  if (dir === "left") return { x: -side * q };
  if (dir === "down") return { y: -size.h * 1.15 * q };
  if (dir === "pop") return { sx: Math.max(0.001, 1 - q), sy: Math.max(0.001, 1 - q) };
  return { x: side * q }; // right
}
export function effectsAt(edit, t, size, shots) {
  const fx = { x: 0, y: 0, rotY: 0, sx: 1, sy: 1, hidden: false };
  let zoom = 1;
  const side = shots ? 2 * shots.body.dist * TAN * 9 / 16 * 0.5 + size.w * 0.6 : size.w * 1.5;
  const out = inOutState(edit.effects, t);
  if (out) { fx.hidden = true; return { fx, zoom }; }
  const add = (o) => {
    if (o.x) fx.x += o.x; if (o.y) fx.y += o.y; if (o.rotY) fx.rotY += o.rotY;
    if (o.sx !== undefined) fx.sx *= o.sx; if (o.sy !== undefined) fx.sy *= o.sy;
  };
  for (const e of edit.effects) {
    if (t < e.t || t > e.t + e.dur) continue;
    const p = clamp01((t - e.t) / e.dur), s = e.strength || 1;
    if (e.type === "punch") {
      const env = p < 0.12 ? outCubic(p / 0.12) : 1 - inOut((p - 0.12) / 0.88);
      zoom *= 1 + 0.35 * s * env;
    } else if (e.type === "bounce") {
      const hops = Math.max(1, Math.round(e.dur / 450)), q = (p * hops) % 1;
      const y = size.h * 0.22 * s * 4 * q * (1 - q);
      const land = 1 - smooth(clamp01(Math.min(q, 1 - q) / 0.12)); // squash near each landing
      const squash = p >= 1 ? 0 : 0.1 * s * land;
      add({ y, sy: 1 - squash, sx: 1 + squash * 0.5 });
    } else if (e.type === "spin") {
      add({ rotY: 2 * Math.PI * (s > 1 ? 2 : 1) * inOut(p) });
    } else if (e.type === "enter") {
      add(away(e.dir, e.dir === "pop" ? 1 - outBack(p) : 1 - outCubic(p), size, side));
    } else if (e.type === "exit") {
      add(away(e.dir, inCubic(p), size, side));
    }
  }
  return { fx, zoom };
}

// ---- background ---------------------------------------------------------------------------------------------
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
export function backgroundAt(edit, t) {
  let cur = edit.bg0 || BG;
  for (const b of sorted(edit.bg)) {
    if (b.t > t) break;
    const p = b.fade > 0 ? clamp01((t - b.t) / b.fade) : 1;
    if (p >= 1) cur = b.color;
    else { const a = rgb(cur), c = rgb(b.color); cur = hex(a.map((v, i) => v + (c[i] - v) * smooth(p))); }
  }
  return cur;
}

// Everything at time t, for the stage: the view (with the punch zoom), the model placement, the background.
export function sceneAt(edit, t, stage) {
  const v = cameraAt(edit, t, stage.shots), { fx, zoom } = effectsAt(edit, t, stage.size, stage.shots);
  return { view: { ...v, dist: v.dist / zoom }, fx, bg: backgroundAt(edit, t) };
}
export function applyScene(stage, sc) {
  stage.view(sc.view);
  stage.place(sc.fx);
  stage.background(sc.bg);
}
