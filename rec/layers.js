// Layers of a frame in the editor and the offline render (docs/phone_recording.md, "Images"): the background (a color
// or an image), images behind Eliran, Eliran (the WebGL canvas, rendered on a transparent clear), images in front.
// One function (composite) draws a frame into a 2D canvas, so the editor preview and the render show the same thing.
// The images are the user's own, picked from the phone and kept in IndexedDB only (key "media:<id>"); the edit holds
// only their ids. bitmaps = Map id -> ImageBitmap (decoded once, downscaled to MAX_SIDE) or null (missing / unreadable).
// Since version 8 a background segment can be a video (video.js): videos = Map id -> VideoSource, whose `cur` frame
// the caller has set to the right time first (videoNeeds: the editor asks without waiting, the render waits).
// Layouts per segment: "full" (the video on the whole frame, Eliran over it), "split" (video in the top half, Eliran in
// the bottom half on the segment color), "corner" (a small window in front of Eliran, dragged like an image).
import { BG } from "./avatar.js?v=8";
import { drawVideo } from "./video.js?v=8";

export const MAX_SIDE = 2048; // decode size cap: enough for 1080x1920 with the slow zoom, small enough for a phone
export const ANIMS = { pop: "צץ", slide: "החלקה", fade: "הופעה", cut: "חיתוך" };
export const SLIDE_DIRS = { right: "מימין", left: "משמאל", up: "מלמעלה", down: "מלמטה" };
export const SPOTS = { // position presets: the image center as a fraction of the frame (x from the left, y from the top)
  top: { name: "למעלה", x: 0.5, y: 0.22 }, mid: { name: "מרכז", x: 0.5, y: 0.45 }, low: { name: "למטה", x: 0.5, y: 0.78 },
  tr: { name: "פינה ימין", x: 0.74, y: 0.16 }, tl: { name: "פינה שמאל", x: 0.26, y: 0.16 },
};
export const LAYOUTS = { full: "מלא", split: "מפוצל", corner: "בפינה" };
export const CORNER = { vx: 0.72, vy: 0.2, vw: 0.46 }; // the corner window at first: center (frame fractions), width
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
  if (edit?.bg0vid) ids.add(edit.bg0vid);
  for (const b of edit?.bg || []) { if (b.img) ids.add(b.img); if (b.vid) ids.add(b.vid); }
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
// The segments as {t, color, img?, fit?, kb?, vid?, vfrom?, layout?, vol?, vx?, vy?, vw?}: the start (bg0*) then
// the changes, by time.
export const SEG_KEYS = ["img", "fit", "kb", "vid", "vfrom", "layout", "vol", "vx", "vy", "vw"];
export function segments(edit) {
  const start = { id: "bg0", t: 0, color: edit.bg0 || BG, fade: 0 };
  for (const k of SEG_KEYS) start[k] = edit["bg0" + k];
  return [start, ...[...(edit.bg || [])].sort((a, b) => a.t - b.t)];
}
// The segment shown at t, the one before it and how far the fade into it is (p = 1: done).
export function segAt(edit, t) {
  const segs = segments(edit);
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].t <= t) i++;
  const cur = segs[i], p = cur.fade > 0 && i > 0 ? clamp01((t - cur.t) / cur.fade) : 1;
  return { cur, prev: p < 1 ? segs[i - 1] : null, p, i, end: segs[i + 1]?.t ?? Infinity };
}
export const layoutOf = (seg) => (seg?.vid ? (LAYOUTS[seg.layout] ? seg.layout : "full") : "full");
// ms into the video of segment seg at take time t (frozen on the last frame by the source after the end)
export const videoTime = (seg, t) => Math.max(0, (seg.vfrom || 0) + (t - seg.t));
// The video frames needed at t: [{vid, ms}] (the segment, and the one before it during a fade).
export function videoNeeds(edit, t) {
  const { cur, prev } = segAt(edit, t), out = [];
  for (const s of [cur, prev]) if (s?.vid && !out.some((o) => o.vid === s.vid)) out.push({ vid: s.vid, ms: videoTime(s, t) });
  return out;
}
// Where Eliran is drawn for a segment: the whole frame, or the bottom half in "split" (9:16 kept, so he fits its height).
function eliranBox(seg, w, h) {
  if (layoutOf(seg) !== "split") return { x: 0, y: 0, w, h };
  const bh = h / 2, bw = bh * 9 / 16;
  return { x: (w - bw) / 2, y: h / 2, w: bw, h: bh };
}
// A source of sw x sh fitted into the box: cover (fills it, cut at the edges) or contain (whole).
function fitIn(sw, sh, x, y, bw, bh, cover) {
  const s = cover ? Math.max(bw / sw, bh / sh) : Math.min(bw / sw, bh / sh), dw = sw * s, dh = sh * s;
  return { x: x + (bw - dw) / 2, y: y + (bh - dh) / 2, w: dw, h: dh };
}
function drawSegVideo(g, w, h, seg, videos) {
  const src = videos?.get(seg.vid), lay = layoutOf(seg);
  if (!src?.cur || lay === "corner") return;
  const box = lay === "split" ? { x: 0, y: 0, w, h: h / 2 } : { x: 0, y: 0, w, h };
  const r = fitIn(src.w, src.h, box.x, box.y, box.w, box.h, seg.fit !== "contain");
  g.save();
  g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();
  drawVideo(g, src.cur, src.rot, r.x, r.y, r.w, r.h);
  g.restore();
}
// The corner window's box in output pixels (null without a frame size).
function cornerBox(seg, src, w, h) {
  if (!src) return null;
  const dw = (seg.vw ?? CORNER.vw) * w, dh = dw * src.h / src.w;
  return { cx: (seg.vx ?? CORNER.vx) * w, cy: (seg.vy ?? CORNER.vy) * h, dw, dh };
}
function drawCorner(g, w, h, seg, videos, alpha, selected) {
  const src = videos?.get(seg.vid), box = cornerBox(seg, src, w, h);
  if (!box || !src.cur) return;
  const { cx, cy, dw, dh } = box, pad = w * 0.012, r = w * 0.03;
  g.save();
  g.globalAlpha = alpha;
  g.shadowColor = "rgba(22,16,28,.5)"; g.shadowBlur = w * 0.025; g.shadowOffsetY = w * 0.008;
  g.fillStyle = "#FFF6EE";
  g.beginPath(); g.roundRect(cx - dw / 2 - pad, cy - dh / 2 - pad, dw + 2 * pad, dh + 2 * pad, r + pad); g.fill();
  g.shadowColor = "transparent";
  g.beginPath(); g.roundRect(cx - dw / 2, cy - dh / 2, dw, dh, r); g.clip();
  drawVideo(g, src.cur, src.rot, cx - dw / 2, cy - dh / 2, dw, dh);
  g.restore();
  if (selected) {
    g.save();
    g.setLineDash([w * 0.02, w * 0.012]); g.lineWidth = w * 0.006; g.strokeStyle = "#FFD23F";
    g.strokeRect(cx - dw / 2 - w * 0.02, cy - dh / 2 - w * 0.02, dw + w * 0.04, dh + w * 0.04);
    g.restore();
  }
}
function drawSeg(g, w, h, seg, t, bitmaps, videos) {
  g.fillStyle = seg.color || BG;
  g.fillRect(0, 0, w, h);
  if (seg.vid) { drawSegVideo(g, w, h, seg, videos); return; }
  const bmp = seg.img ? bitmaps?.get(seg.img) : null;
  if (!bmp) return;
  const cover = seg.fit !== "contain";
  let s = cover ? Math.max(w / bmp.width, h / bmp.height) : Math.min(w / bmp.width, h / bmp.height);
  if (seg.kb) s *= 1 + Math.min(0.3, 0.025 * Math.max(0, t - seg.t) / 1000); // slow zoom in, up to 30%
  const dw = bmp.width * s, dh = bmp.height * s;
  g.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
function drawBackground(g, w, h, at, t, bitmaps, videos) {
  const { cur, prev, p } = at;
  if (prev) {
    drawSeg(g, w, h, prev, t, bitmaps, videos);
    g.globalAlpha = smooth(p);
    drawSeg(g, w, h, cur, t, bitmaps, videos);
    g.globalAlpha = 1;
  } else drawSeg(g, w, h, cur, t, bitmaps, videos);
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

// One frame: background (color, image or video), images behind, Eliran (gl = the WebGL canvas, any size, 9:16; the
// bottom half in "split"), the corner video, images in front. opts.sel = the id of an image or background segment to
// mark (editor preview only). videos = Map id -> VideoSource (version 8).
export function composite(g, w, h, edit, t, gl, bitmaps, opts = {}, videos = null) {
  const at = segAt(edit, t), q = smooth(at.p);
  drawBackground(g, w, h, at, t, bitmaps, videos);
  drawImages(g, w, h, edit, t, bitmaps, "back", opts.sel);
  const a = eliranBox(at.cur, w, h), b = at.prev ? eliranBox(at.prev, w, h) : a; // a fade between layouts moves the box
  const lerp = (k) => b[k] + (a[k] - b[k]) * q;
  g.drawImage(gl, lerp("x"), lerp("y"), lerp("w"), lerp("h"));
  if (at.prev && layoutOf(at.prev) === "corner") drawCorner(g, w, h, at.prev, videos, 1 - q, false);
  if (layoutOf(at.cur) === "corner") drawCorner(g, w, h, at.cur, videos, q, opts.sel === at.cur.id);
  drawImages(g, w, h, edit, t, bitmaps, "front", opts.sel);
}

// The corner video under the point (fx, fy frame fractions) at t, or null: the segment shown then.
export function hitVideo(edit, t, fx, fy, videos) {
  const { cur } = segAt(edit, t);
  if (layoutOf(cur) !== "corner") return null;
  const box = cornerBox(cur, videos?.get(cur.vid), 1, 1);
  if (!box) return null;
  const px = Math.abs(fx - box.cx), py = Math.abs(fy - box.cy) * 16 / 9; // in widths, as boxOf(.., 1, 1)
  return px <= box.dw / 2 + 0.03 && py <= box.dh / 2 + 0.03 ? cur : null;
}

// ---- sound -----------------------------------------------------------------------------------------------------
// The whole take's sound on the take clock (sample 0 = t 0): Eliran's voice (shifted by voiceStart ms, as the mic
// started after t0) + the sound of every video segment at its volume (vol 0..1, default VOL), from vfrom on, silent
// after the video's end. One function for the editor playback and the render, so they sound the same.
// sounds = Map vid -> AudioBuffer at sampleRate (null = no sound). -> AudioBuffer, or null when there is nothing.
export const VOL = 0.5;
export function mixAudio({ voice, voiceStart = 0, edit, sounds, lengthMs, sampleRate }) {
  const sr = voice?.sampleRate || sampleRate || 48000, n = Math.max(1, Math.round(lengthMs / 1000 * sr));
  const segs = segments(edit), used = [];
  segs.forEach((s, i) => {
    const buf = s.vid ? sounds?.get(s.vid) : null, vol = s.vol ?? VOL;
    if (buf && vol > 0 && buf.sampleRate === sr) used.push({ s, buf, vol, end: segs[i + 1]?.t ?? lengthMs, prev: segs[i - 1], next: segs[i + 1] });
  });
  if (!voice && !used.length) return null;
  const ch = Math.min(2, Math.max(voice?.numberOfChannels || 1, ...used.map((u) => u.buf.numberOfChannels)));
  const out = new AudioBuffer({ length: n, numberOfChannels: ch, sampleRate: sr });
  const data = [...Array(ch)].map((_, c) => out.getChannelData(c));
  if (voice) {
    const shift = Math.round(voiceStart / 1000 * sr);
    for (let c = 0; c < ch; c++) {
      const src = voice.getChannelData(Math.min(c, voice.numberOfChannels - 1)), d = data[c];
      for (let i = Math.max(0, shift); i < n; i++) { const j = i - shift; if (j >= src.length) break; d[i] = src[j]; }
    }
  }
  // the same video going on across a segment change (a layout change mid-video) is not faded there
  const goesOn = (a, b) => a && b && a.vid === b.vid && Math.abs(videoTime(a, b.t) - (b.vfrom || 0)) < 1 && (a.vol ?? VOL) === (b.vol ?? VOL);
  const RAMP = Math.round(0.01 * sr);
  for (const { s, buf, vol, end, prev, next } of used) {
    const a = Math.round(s.t / 1000 * sr), b = Math.min(n, Math.round(end / 1000 * sr)), off = Math.round((s.vfrom || 0) / 1000 * sr) - a;
    const fadeIn = !goesOn(prev, s), fadeOut = !goesOn(s, next);
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), d = data[c];
      for (let i = a; i < b; i++) {
        const k = i + off;
        if (k < 0) continue;
        if (k >= src.length) break;
        let gn = vol;
        if (fadeIn && i - a < RAMP) gn *= (i - a) / RAMP;
        if (fadeOut && b - i < RAMP) gn *= (b - i) / RAMP;
        d[i] += src[k] * gn;
      }
    }
  }
  // a soft limit above 0.9 so voice + video never clip hard
  if (used.length) for (const d of data) for (let i = 0; i < n; i++) {
    const x = d[i], ax = Math.abs(x);
    if (ax > 0.9) d[i] = Math.sign(x) * (0.9 + 0.1 * Math.tanh((ax - 0.9) / 0.1));
  }
  return out;
}
// A key that changes when the mix would (the editor re-mixes only then).
export const soundKey = (edit) => JSON.stringify(segments(edit).map((s) => [s.t, s.vid || 0, s.vfrom || 0, s.vol ?? VOL]));

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
