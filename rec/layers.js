// Layers of a frame in the editor and the offline render (docs/phone_recording.md, "Images"): the background (a color
// or an image), images behind Eliran, Eliran (the WebGL canvas, rendered on a transparent clear), images in front.
// One function (composite) draws a frame into a 2D canvas, so the editor preview and the render show the same thing.
// The images are the user's own, picked from the phone and kept in IndexedDB only (key "media:<id>"); the edit holds
// only their ids. bitmaps = Map id -> ImageBitmap (decoded once, downscaled to MAX_SIDE) or null (missing / unreadable).
import { BG } from "./avatar.js?v=7";

export const MAX_SIDE = 2048; // decode size cap: enough for 1080x1920 with the slow zoom, small enough for a phone
export const ANIMS = { pop: "צץ", slide: "החלקה", fade: "הופעה", cut: "חיתוך" };
export const SLIDE_DIRS = { right: "מימין", left: "משמאל", up: "מלמעלה", down: "מלמטה" };
export const SPOTS = { // position presets: the image center as a fraction of the frame (x from the left, y from the top)
  top: { name: "למעלה", x: 0.5, y: 0.22 }, mid: { name: "מרכז", x: 0.5, y: 0.45 }, low: { name: "למטה", x: 0.5, y: 0.78 },
  tr: { name: "פינה ימין", x: 0.74, y: 0.16 }, tl: { name: "פינה שמאל", x: 0.26, y: 0.16 },
};
const IN = 300, OUT = 250; // ms of the enter / leave animation (cut down to half the image's time when it is short)

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const inCubic = (x) => x * x * x;
const outBack = (x) => { const c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

// Every media id the edit uses (the background segments and the images).
export function mediaIds(edit) {
  const ids = new Set();
  if (edit?.bg0img) ids.add(edit.bg0img);
  for (const b of edit?.bg || []) if (b.img) ids.add(b.img);
  for (const m of edit?.media || []) if (m.img) ids.add(m.img);
  return ids;
}

// Decode a picked image (Blob) to a bitmap no larger than MAX_SIDE. EXIF rotation is applied by the browser.
export async function decode(blob) {
  const full = await createImageBitmap(blob);
  const s = Math.min(1, MAX_SIDE / Math.max(full.width, full.height));
  if (s >= 1) return full;
  const w = Math.max(1, Math.round(full.width * s)), h = Math.max(1, Math.round(full.height * s));
  full.close();
  return createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
}

// ---- background ----------------------------------------------------------------------------------------------
// The segments as {t, color, img?, fit?, kb?}: the start (bg0*) then the changes, by time.
function segments(edit) {
  const start = { t: 0, color: edit.bg0 || BG, img: edit.bg0img, fit: edit.bg0fit, kb: edit.bg0kb, fade: 0 };
  return [start, ...[...(edit.bg || [])].sort((a, b) => a.t - b.t)];
}
function drawSeg(g, w, h, seg, t, bitmaps) {
  g.fillStyle = seg.color || BG;
  g.fillRect(0, 0, w, h);
  const bmp = seg.img ? bitmaps?.get(seg.img) : null;
  if (!bmp) return;
  const cover = seg.fit !== "contain";
  let s = cover ? Math.max(w / bmp.width, h / bmp.height) : Math.min(w / bmp.width, h / bmp.height);
  if (seg.kb) s *= 1 + Math.min(0.3, 0.025 * Math.max(0, t - seg.t) / 1000); // slow zoom in, up to 30%
  const dw = bmp.width * s, dh = bmp.height * s;
  g.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
function drawBackground(g, w, h, edit, t, bitmaps) {
  const segs = segments(edit);
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].t <= t) i++;
  const cur = segs[i], p = cur.fade > 0 ? clamp01((t - cur.t) / cur.fade) : 1;
  if (p < 1 && i > 0) {
    drawSeg(g, w, h, segs[i - 1], t, bitmaps);
    g.globalAlpha = smooth(p);
    drawSeg(g, w, h, cur, t, bitmaps);
    g.globalAlpha = 1;
  } else drawSeg(g, w, h, cur, t, bitmaps);
}

// ---- images --------------------------------------------------------------------------------------------------
// The state of image m at t, or null when it is not on screen: {alpha, scale, dx, dy} (dx/dy in frame fractions).
function stateAt(m, t) {
  if (t < m.t || t > m.t + m.dur) return null;
  const inMs = Math.min(IN, m.dur / 2), outMs = Math.min(OUT, m.dur / 2);
  const a = t - m.t, b = m.t + m.dur - t;
  const st = { alpha: 1, scale: 1, dx: 0, dy: 0 };
  const anim = m.anim || "pop";
  const step = (q, entering) => { // q = 1 fully shown, 0 gone
    if (anim === "pop") st.scale = Math.max(0.001, entering ? outBack(q) : outCubic(q));
    else if (anim === "fade") st.alpha = smooth(q);
    else if (anim === "slide") {
      const d = entering ? 1 - outCubic(q) : inCubic(1 - q); // 0 in place, 1 off the frame
      const dir = m.dir || "right";
      if (dir === "right") st.dx = 1.2 * d; else if (dir === "left") st.dx = -1.2 * d;
      else if (dir === "up") st.dy = -1.2 * d; else st.dy = 1.2 * d;
    }
  };
  if (anim !== "cut") {
    if (a < inMs) step(a / inMs, true);
    else if (b < outMs) step(b / outMs, false);
  }
  return st;
}
// The image's box at full size, in output pixels: {cx, cy, dw, dh} (null without a bitmap).
function boxOf(m, bmp, w, h) {
  if (!bmp) return null;
  const dw = (m.w || 0.6) * w, dh = dw * bmp.height / bmp.width;
  return { cx: (m.x ?? 0.5) * w, cy: (m.y ?? 0.45) * h, dw, dh };
}
function drawImage(g, w, h, m, st, bmp, selected) {
  const box = boxOf(m, bmp, w, h);
  if (!box) return;
  const { dw, dh } = box;
  g.save();
  g.globalAlpha = st.alpha;
  g.translate(box.cx + st.dx * w, box.cy + st.dy * h);
  g.rotate(((m.rot || 0) * Math.PI) / 180);
  g.scale(st.scale, st.scale);
  if (m.style === "sticker") {
    const pad = w * 0.018, r = w * 0.03;
    g.shadowColor = "rgba(22,16,28,.45)"; g.shadowBlur = w * 0.025; g.shadowOffsetY = w * 0.008;
    g.fillStyle = "#FFF6EE";
    g.beginPath(); g.roundRect(-dw / 2 - pad, -dh / 2 - pad, dw + 2 * pad, dh + 2 * pad, r + pad); g.fill();
    g.shadowColor = "transparent";
    g.beginPath(); g.roundRect(-dw / 2, -dh / 2, dw, dh, r); g.clip();
  }
  g.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  g.restore();
  if (selected) { // the editor only: a dashed frame on the selected image
    g.save();
    g.translate(box.cx + st.dx * w, box.cy + st.dy * h);
    g.rotate(((m.rot || 0) * Math.PI) / 180);
    g.scale(st.scale, st.scale);
    g.setLineDash([w * 0.02, w * 0.012]);
    g.lineWidth = w * 0.006; g.strokeStyle = "#FFD23F";
    g.strokeRect(-dw / 2 - w * 0.01, -dh / 2 - w * 0.01, dw + w * 0.02, dh + w * 0.02);
    g.restore();
  }
}
function drawImages(g, w, h, edit, t, bitmaps, layer, sel) {
  for (const m of edit.media || []) {
    if ((m.layer === "back" ? "back" : "front") !== layer) continue;
    const st = stateAt(m, t);
    if (st) drawImage(g, w, h, m, st, bitmaps?.get(m.img), m.id === sel);
  }
}

// One frame: background, images behind, Eliran (gl = the WebGL canvas, any size, 9:16), images in front.
// opts.sel = the id of an image to mark (editor preview only).
export function composite(g, w, h, edit, t, gl, bitmaps, opts = {}) {
  drawBackground(g, w, h, edit, t, bitmaps);
  drawImages(g, w, h, edit, t, bitmaps, "back", opts.sel);
  g.drawImage(gl, 0, 0, w, h);
  drawImages(g, w, h, edit, t, bitmaps, "front", opts.sel);
}

// The topmost image on screen at t under the point (fx, fy in frame fractions), or null. Front before back.
export function hitImage(edit, t, fx, fy, bitmaps) {
  const list = [...(edit.media || [])];
  const order = [...list.filter((m) => m.layer !== "back").reverse(), ...list.filter((m) => m.layer === "back").reverse()];
  for (const m of order) {
    const st = stateAt(m, t), box = st && boxOf(m, bitmaps?.get(m.img), 1, 1);
    if (!box) continue;
    // into the image's own frame (aspect 9:16 kept: x in widths, y in heights -> both in widths)
    const px = (fx - box.cx - st.dx), py = (fy - box.cy - st.dy) * 16 / 9;
    const a = -((m.rot || 0) * Math.PI) / 180, rx = (px * Math.cos(a) - py * Math.sin(a)) / st.scale, ry = (px * Math.sin(a) + py * Math.cos(a)) / st.scale;
    const hw = box.dw / 2 + 0.03, hh = box.dh / 2 + 0.03; // boxOf(.., 1, 1) gives dh in widths too
    if (Math.abs(rx) <= hw && Math.abs(ry) <= hh) return m;
  }
  return null;
}
// When the image is fully on screen (for the editor: show it while it is being edited).
export const shownAt = (m) => m.t + Math.min(IN, m.dur / 2) + 20;
