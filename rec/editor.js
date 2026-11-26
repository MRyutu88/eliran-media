// The editor on a take (docs/phone_recording.md, "Editor"): Eliran on top, four strips below (מצלמה / אפקטים / רקע / תמונות)
// like CapCut (the layout the user picked, 25.11). Time runs right to left (Hebrew), the playhead stays in the middle
// and the strips move under it: drag to scrub, tap a block to edit it below the strips, drag a selected block to move
// it. The edit (edit.js) is saved with the take on every change; "רנדר" makes the video offline (render.js).
// Text in Hebrew; values from the take are set with textContent.
import { readTake, PoseTrack } from "./take.js?v=8";
import { FaceRig } from "./mapping.js?v=8";
import { BG } from "./avatar.js?v=8";
import { newEdit, checkEdit, newId, sceneAt, applyScene, cameraAt, COLORS, EFFECTS, DIRS, SHOTS } from "./edit.js?v=8";
import { renderTake, support, SIZES } from "./render.js?v=8";
import { BodyRig } from "./body.js?v=8";
import { processVoice, voiceKey } from "./voice.js?v=8";
import { composite, decode, mediaIds, hitImage, hitVideo, shownAt, segAt, videoNeeds, mixAudio, soundKey, layoutOf,
         SEG_KEYS, LAYOUTS, CORNER, VOL, ANIMS, SLIDE_DIRS, SPOTS } from "./layers.js?v=8";
import { VideoSource, audioOf, drawVideo, supported as videoSupported } from "./video.js?v=8";

const $ = (id) => document.getElementById(id);
const fmtT = (ms) => {
  const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ROW = { camera: 0, effects: 1, bg: 2, media: 3 };
const RULER = 18, ROW_H = 34;
const light = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return r * 0.3 + g * 0.59 + b * 0.11 > 150; };

// ctx: {stage, getAudio() -> AudioContext, putTake(rec), storeTake(rec), openResult(rec), say(text, bad),
//       media: {put(rec), get(id)} (the picked images, app.js "media:<id>"),
//       bodySettings (body.js, the current "⚙ הגדרות"), voiceSettings (voice.js), openSettings(), onClose(saved)}
// Draft: the edit is the take's draft. It is saved on every change (400 ms later) and the bar says so ("✓ נשמר");
// "שמור וסגור" saves at once and leaves; the takes list shows it under "טיוטות" until it is rendered.
export function createEditor(ctx) {
  const { stage } = ctx;
  const ui = {
    root: $("editor"), title: $("ed-title"), play: $("ed-play"), time: $("ed-time"), undo: $("ed-undo"),
    zin: $("ed-zin"), zout: $("ed-zout"), set: $("ed-set"), tl: $("ed-tl"), content: $("ed-content"), add: $("ed-add"),
    addCam: $("ed-add-cam"), addFx: $("ed-add-fx"), addBg: $("ed-add-bg"), addImg: $("ed-add-img"), pick: $("ed-pick"),
    pickVid: $("ed-pick-vid"),
    comp: $("ed-comp"),
    sheet: $("ed-sheet"), shTitle: $("ed-sh-title"), shBody: $("ed-sh-body"), shHere: $("ed-sh-here"),
    shDel: $("ed-sh-del"), shOk: $("ed-sh-ok"), close: $("ed-close"), render: $("ed-render"), saved: $("ed-saved"),
    rSheet: $("render"), rOpts: $("r-opts"), rNote: $("r-note"), rGo: $("r-go"), rCancel: $("r-cancel"),
    rBar: $("r-bar"), rFill: $("r-fill"), rText: $("r-text"),
  };
  let S = null; // the open editor: {rec, data, pose, edit, dur, tv, k, playing, sel, ...}
  const opts = { size: "1080", fps: 30, ss: 1 };

  // ---- open / close -----------------------------------------------------------------------------------------
  async function open(rec) {
    if (!stage.vrm) return;
    ctx.say("פותח את העורך…");
    let data;
    try { data = await readTake(rec.perf); } catch (e) { console.error(e); ctx.say("קובץ הביצוע לא נקרא.", true); return; }
    let edit;
    try { edit = checkEdit(rec.edit) ? structuredClone(rec.edit) : newEdit(data); }
    catch { ctx.say("העריכה נשמרה בגרסה חדשה יותר של הדף. לרענן את הדף.", true); return; }
    const rig = new FaceRig(stage.vrm);
    const body = new BodyRig(stage.vrm, stage, ctx.bodySettings);
    S = { rec, data, edit, pose: new PoseTrack(data, rig, body), dur: data.header.durationMs, tv: 0, k: 0.06,
          playing: false, sel: null, undo: [], buffer: null, raw: null, voiceKey: null, src: null, rendering: false,
          bmp: new Map(), thumbs: new Map(), videos: new Map(), sounds: new Map(), mix: null, mixKey: null, notes: new Map() };
    await loadMedia(mediaIds(edit));
    if (data.audio) {
      try {
        const ac = ctx.getAudio(); await ac.resume();
        S.raw = await ac.decodeAudioData(await data.audio.arrayBuffer());
        await voiceNow();
      } catch (e) { console.warn("editor audio", e); }
    }
    remix();
    showSaved(rec.edit ? "saved" : "new");
    ctx.say("");
    ui.title.textContent = rec.name;
    ui.root.hidden = false;
    document.body.classList.add("editing");
    stage.background(null); // Eliran on a transparent clear; the background and the images are 2D layers (drawn())
    stage.vrm.springBoneManager?.reset();
    select(null);
    draw();
    window.__rec.editor = api;
  }
  async function close() {
    if (!S || S.rendering) return;
    pause();
    const had = !!S.rec.edit || saveTimer !== null;
    const ok = await flushSave();
    if (!S) return;
    for (const b of S.bmp.values()) b?.close?.();
    for (const v of S.videos.values()) v?.close?.();
    S = null;
    ui.root.hidden = true;
    document.body.classList.remove("editing");
    stage.place(null);
    stage.background(BG);
    stage.frame(stage.framing);
    stage.vrm?.springBoneManager?.reset();
    ctx.onClose(had && ok !== false);
  }
  ui.close.onclick = close;
  ui.set.onclick = () => { if (S && !S.rendering) ctx.openSettings(); };
  // "⚙ הגדרות" changed: the body track of the whole take is computed again (a few ms).
  function bodyChanged() { if (S && !S.rendering) S.pose.setBody(ctx.bodySettings); }
  // "🎤 קול" changed: the take's sound is processed again (voice.js); playback goes on from the same point.
  async function voiceNow() {
    if (!S?.raw) return;
    const key = voiceKey(ctx.voiceSettings);
    if (key === S.voiceKey) return;
    const s0 = S, buf = await processVoice(S.raw, ctx.voiceSettings);
    if (S !== s0) return;
    S.buffer = buf; S.voiceKey = key;
    S.mixKey = null;
    remix();
  }
  // The sound played in the editor: the voice + the background videos' sound (layers.js mixAudio, as the render).
  // Mixed again only when the voice or the video segments change; playback goes on from the same point.
  function remix() {
    if (!S) return;
    const sr = S.buffer?.sampleRate || ctx.getAudio()?.sampleRate || 48000;
    const key = soundKey(S.edit) + "|" + S.voiceKey + "|" + sr + "|" + [...S.sounds.keys()].join(",");
    if (key === S.mixKey) return;
    S.mixKey = key;
    const sounds = new Map([...S.sounds].filter(([, b]) => b && b.sampleRate === sr));
    S.mix = mixAudio({ voice: S.buffer, voiceStart: S.data.header.audio?.startMs ?? 0, edit: S.edit, sounds, lengthMs: S.dur, sampleRate: sr });
    if (S.playing) { pause(); play(); }
  }
  let mixTimer = null;
  const remixSoon = () => { clearTimeout(mixTimer); mixTimer = setTimeout(remix, 150); };
  let voiceTimer = null;
  function voiceChanged() { clearTimeout(voiceTimer); voiceTimer = setTimeout(() => voiceNow().catch((e) => console.warn("voice", e)), 250); }

  // ---- saving (debounced) and undo ------------------------------------------------------------------------------
  let saveTimer = null;
  function changed(snapshot) {
    if (snapshot) { S.undo.push(snapshot); if (S.undo.length > 50) S.undo.shift(); }
    S.edit.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
    showSaved("dirty");
    remixSoon();
    draw();
  }
  // -> Promise: true saved, false failed, undefined nothing to save.
  function flushSave() {
    if (!S || saveTimer === null) return Promise.resolve();
    clearTimeout(saveTimer); saveTimer = null;
    S.rec.edit = structuredClone(S.edit);
    showSaved("saving");
    const s0 = S;
    return ctx.putTake(S.rec).then(() => { if (S === s0) showSaved("saved"); return true; })
      .catch((e) => { console.error(e); if (S === s0) showSaved("fail"); ctx.say("לא הצלחתי לשמור את הטיוטה (אין מקום בטלפון?).", true); return false; });
  }
  // The save state in the bar: new (nothing edited yet), dirty, saving, saved (with the time), fail.
  function showSaved(state) {
    const t = S?.rec.edit?.updated ? new Date(S.rec.edit.updated).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "";
    const text = { new: "טיוטה חדשה", dirty: "• שומר…", saving: "• שומר…", saved: "✓ נשמר", fail: "⚠ לא נשמר" }[state];
    ui.saved.textContent = text;
    ui.saved.dataset.state = state;
    ui.saved.title = t ? `נשמר בטלפון ${t}` : "";
    if (window.__rec) window.__rec.draftState = state;
  }
  const snap = () => JSON.stringify(S.edit);
  ui.undo.onclick = () => {
    if (!S?.undo.length) return;
    S.edit = JSON.parse(S.undo.pop());
    if (S.sel && !find(S.sel)) select(null);
    changed(null);
    if (S.sel) sheet();
  };

  // ---- playback -----------------------------------------------------------------------------------------------
  function play() {
    if (!S || S.playing) return;
    if (S.tv >= S.dur - 10) seek(0);
    S.playing = true;
    ui.play.textContent = "❚❚";
    const ac = ctx.getAudio(), now = performance.now();
    S.p0 = { perf: now, tv: S.tv };
    if (S.mix && ac) { // the mix is on the take clock (layers.js mixAudio)
      const when = ac.currentTime + 0.06, off = S.tv / 1000;
      const src = ac.createBufferSource();
      src.buffer = S.mix;
      src.connect(ac.destination);
      src.start(when, Math.min(off, S.mix.duration));
      S.src = src;
      S.p0 = { ac: when, tv: S.tv };
    }
  }
  function pause() {
    if (!S?.playing) return;
    S.playing = false;
    ui.play.textContent = "▶";
    try { S.src?.stop(); } catch { /* not started */ }
    S.src = null;
  }
  ui.play.onclick = () => (S?.playing ? pause() : play());
  function seek(t, jump = false) {
    S.tv = Math.min(S.dur, Math.max(0, t));
    if (jump) stage.vrm.springBoneManager?.reset();
  }

  // Called from the page loop before each render while the editor is open.
  function tick() {
    if (!S || S.rendering) return;
    if (S.playing) {
      const ac = ctx.getAudio();
      if (S.p0.ac != null && ac) S.tv = S.p0.tv + (ac.currentTime - (ac.outputLatency || 0) - S.p0.ac) * 1000;
      else S.tv = S.p0.tv + (performance.now() - S.p0.perf);
      if (S.tv >= S.dur) { S.tv = S.dur; pause(); }
    }
    S.pose.at(S.tv);
    applyScene(stage, sceneAt(S.edit, S.tv, stage));
    for (const n of videoNeeds(S.edit, S.tv)) S.videos.get(n.vid)?.want(n.ms); // the preview: the latest frame wins
    place();
  }

  // ---- the strips ---------------------------------------------------------------------------------------------
  // #ed-content is anchored with its right edge at the middle (the playhead) and moved right by tv*k: the item at t
  // sits t*k from the content's right edge, so the time under the playhead is always tv.
  function place() {
    ui.content.style.transform = `translateX(${S.tv * S.k}px)`;
    ui.time.textContent = `${fmtT(S.tv)} / ${fmtT(S.dur)}`;
  }
  const isCustom = (k) => Math.abs((k.zoom ?? 1) - 1) > 0.01 || Math.abs(k.panX || 0) > 0.005 || Math.abs(k.panY || 0) > 0.005;
  const camName = (k) => (isCustom(k) ? "מותאם" : SHOTS[k.shot] || "מלא");
  function draw() {
    if (!S) return;
    const { k, dur, edit } = S, c = ui.content;
    c.replaceChildren();
    c.style.width = `${dur * k}px`;
    // ruler
    const ruler = el("div", "ed-ruler"); c.append(ruler);
    const step = k > 0.09 ? 500 : k > 0.03 ? 1000 : k > 0.012 ? 5000 : 10000;
    for (let t = 0; t <= dur; t += step) {
      const tick = el("span", (t / 1000) % 1 === 0 ? "" : "half", (t / 1000) % 1 === 0 ? fmtT(t).replace(/\.0$/, "") : "");
      tick.style.right = `${t * k}px`;
      ruler.append(tick);
    }
    const rows = ["camera", "effects", "bg", "media"].map((name) => {
      const r = el("div", "ed-row"); r.style.top = `${RULER + ROW[name] * ROW_H}px`; c.append(r); return r;
    });
    const item = (row, id, t, w, label, bg, fg) => {
      const it = el("div", "it" + (S.sel === id ? " sel" : ""), label);
      it.dataset.id = id;
      it.style.right = `${t * k}px`;
      it.style.width = `${Math.max(18, w)}px`;
      it.style.background = bg;
      if (fg) it.style.color = fg;
      rows[row].append(it);
      return it;
    };
    const withThumb = (it, img) => {
      const u = img && S.thumbs.get(img);
      if (!u) return;
      it.style.backgroundImage = `url(${u})`;
      it.classList.add("img");
    };
    // camera: the start view, then each key with its move
    const keys = [...edit.camera].sort((a, b) => a.t - b.t);
    item(0, "cam0", 0, Math.min(keys[0]?.t ?? dur, 1500) * k, "פתיחה: " + camName(edit.cam0), "#8f63c2", "#fff");
    for (const key of keys) item(0, key.id, key.t, (key.move || 0) * k, `${camName(key)}${key.move ? "" : " ✂"}`, "#C77DFF");
    // effects
    for (const e of edit.effects) item(1, e.id, e.t, e.dur * k, EFFECTS[e.type]?.name + (e.dir && (e.type === "enter" || e.type === "exit") ? " " + DIRS[e.dir] : ""), "#FF8FCF");
    // background: segments to the next change
    const bgs = [...edit.bg].sort((a, b) => a.t - b.t);
    const segs = [{ id: "bg0", t: 0, color: edit.bg0, img: edit.bg0img, vid: edit.bg0vid, layout: edit.bg0layout }, ...bgs];
    segs.forEach((b, i) => {
      const end = segs[i + 1]?.t ?? dur;
      const name = b.vid ? (S.videos.get(b.vid) ? "🎬 " + LAYOUTS[layoutOf(b)] : "⚠ וידאו חסר") : b.img ? "🖼 תמונה"
        : COLORS.find((x) => x.color.toLowerCase() === b.color.toLowerCase())?.name || b.color;
      withThumb(item(2, b.id, b.t, (end - b.t) * k, name, b.color, light(b.color) ? "#16101C" : "#FFF6EE"), b.vid || b.img);
    });
    // images
    for (const m of edit.media) {
      const it = item(3, m.id, m.t, m.dur * k, m.layer === "back" ? "🖼 מאחור" : "🖼", "#3DD9C9", "#16101C");
      withThumb(it, m.img);
      if (!S.bmp.get(m.img)) it.textContent = "⚠ חסרה";
    }
    place();
    ui.undo.disabled = !S.undo.length;
  }
  ui.zin.onclick = () => { if (S) { S.k = Math.min(0.3, S.k * 1.5); draw(); } };
  ui.zout.onclick = () => { if (S) { S.k = Math.max(0.006, S.k / 1.5); draw(); } };

  // drag = scrub (or move the selected block); a tap selects the block under the finger
  let drag = null;
  ui.tl.addEventListener("pointerdown", (e) => {
    if (!S || S.rendering) return;
    const id = e.target.closest?.(".it")?.dataset.id ?? null;
    const moving = id && id === S.sel && id !== "cam0" && id !== "bg0" ? find(id) : null;
    drag = { x0: e.clientX, tv0: S.tv, id, moving, t0: moving?.t, moved: false, before: moving ? snap() : null };
    ui.tl.setPointerCapture(e.pointerId);
    if (S.playing && !moving) pause();
  });
  ui.tl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 6) return;
    drag.moved = true;
    if (drag.moving) {
      drag.moving.t = Math.round(Math.min(S.dur, Math.max(0, drag.t0 - dx / S.k)));
      draw();
    } else seek(drag.tv0 + dx / S.k);
  });
  const up = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moving && d.moved) { changed(d.before); sheet(); return; }
    if (!d.moved) select(d.id);
  };
  ui.tl.addEventListener("pointerup", up);
  ui.tl.addEventListener("pointercancel", up);

  // ---- items ---------------------------------------------------------------------------------------------------
  function find(id) {
    const e = S.edit;
    if (id === "cam0") return e.cam0;
    // the start segment: its fields live on the edit as bg0 (the color) and bg0<field> (layers.js SEG_KEYS)
    if (id === "bg0") return new Proxy({}, {
      get: (_, k) => (k === "id" ? "bg0" : k === "t" || k === "fade" ? 0 : k === "color" ? e.bg0 : SEG_KEYS.includes(k) ? e["bg0" + k] : undefined),
      set: (_, k, v) => {
        if (k === "color") e.bg0 = v;
        else if (SEG_KEYS.includes(k)) { if (v === undefined) delete e["bg0" + k]; else e["bg0" + k] = v; }
        return true;
      },
    });
    return e.camera.find((x) => x.id === id) || e.effects.find((x) => x.id === id) || e.bg.find((x) => x.id === id)
      || e.media.find((x) => x.id === id) || null;
  }
  const kindOf = (id) => (id === "cam0" || S.edit.camera.some((x) => x.id === id) ? "camera"
    : S.edit.effects.some((x) => x.id === id) ? "effects" : S.edit.media.some((x) => x.id === id) ? "media" : "bg");
  function select(id) {
    if (S) S.sel = id;
    const m = id && S?.edit.media.find((x) => x.id === id);
    if (m && !S.playing && (S.tv < shownAt(m) || S.tv > m.t + m.dur - 260)) seek(Math.min(shownAt(m), m.t + m.dur), true);
    ui.sheet.hidden = !id;
    ui.add.hidden = !!id;
    if (id) sheet();
    draw();
  }
  ui.shOk.onclick = () => select(null);
  ui.shDel.onclick = () => {
    const id = S.sel; if (!id || id === "cam0" || id === "bg0") return;
    const before = snap();
    for (const list of [S.edit.camera, S.edit.effects, S.edit.bg, S.edit.media]) { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); }
    S.sel = null; changed(before); select(null);
  };
  ui.shHere.onclick = () => {
    const it = find(S.sel); if (!it || S.sel === "cam0" || S.sel === "bg0") return;
    const before = snap(); it.t = Math.round(S.tv); changed(before); sheet();
  };

  ui.addCam.onclick = () => {
    const before = snap(), now = cameraAt(S.edit, S.tv, stage.shots);
    // the new key starts as the other framing (the usual "now go close"), keeping nothing custom
    const cur = [...S.edit.camera].filter((x) => x.t <= S.tv).sort((a, b) => b.t - a.t)[0] || S.edit.cam0;
    const shot = cur.shot === "close" && !isCustom(cur) ? "body" : (now.dist > stage.shots.close.dist * 1.2 ? "close" : "body");
    const key = { id: newId(), t: Math.round(S.tv), shot, zoom: 1, panX: 0, panY: 0, move: 600, ease: "smooth" };
    S.edit.camera.push(key); changed(before); select(key.id);
  };
  ui.addFx.onclick = () => {
    const before = snap(), fx = { id: newId(), t: Math.round(S.tv), type: "bounce", dur: EFFECTS.bounce.dur, strength: 1 };
    S.edit.effects.push(fx); changed(before); select(fx.id);
  };
  ui.addBg.onclick = () => {
    const before = snap(), t = Math.round(S.tv), { cur: seg } = segAt(S.edit, t);
    let b;
    if (seg.vid) { // a change while a video plays: the same video goes on (to change the layout mid-video)
      b = { id: newId(), t, color: seg.color, fade: 0, vid: seg.vid, vfrom: Math.round((seg.vfrom || 0) + t - seg.t),
            layout: layoutOf(seg) === "full" ? "split" : "full", fit: seg.fit, vol: seg.vol ?? VOL,
            vx: seg.vx, vy: seg.vy, vw: seg.vw };
      for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
    } else {
      const cur = sceneAt(S.edit, S.tv, stage).bg.toLowerCase();
      const color = (COLORS.find((c) => c.color.toLowerCase() !== cur && c.color !== BG) || COLORS[1]).color;
      b = { id: newId(), t, color, fade: 0 };
    }
    S.edit.bg.push(b); changed(before); select(b.id);
  };

  // The panel under the strips for the selected block.
  function chips(label, values, current, set) {
    const wrap = el("div", "ed-field"), row = el("div", "chips");
    wrap.append(el("span", "ed-lbl2", label), row);
    for (const [v, text] of values) {
      const b = el("button", "", text);
      b.setAttribute("aria-pressed", String(v === current));
      b.onclick = () => { const before = snap(); set(v); changed(before); sheet(); };
      row.append(b);
    }
    return wrap;
  }
  function slider(label, min, max, step, value, set, ends, show) {
    const wrap = el("div", "ed-field ed-slide"), input = el("input"), val = show ? el("output", "ed-val") : null;
    Object.assign(input, { type: "range", min, max, step, value });
    input.dir = "ltr";
    let before = null;
    const paint = () => { if (val) val.textContent = show(Number(input.value)); };
    paint();
    input.onpointerdown = () => { before = snap(); };
    input.oninput = () => { if (!before) before = snap(); set(Number(input.value)); paint(); S.edit.updated = Date.now(); showSaved("dirty"); };
    input.onchange = () => { changed(before); before = null; };
    const l = el("span", "ed-lbl2", label);
    const r = el("div", "ed-ends");
    if (ends) r.append(el("span", "", ends[0]), input, el("span", "", ends[1])); else r.append(input);
    wrap.append(l, r);
    if (val) wrap.append(val);
    return wrap;
  }
  function sheet() {
    const id = S.sel, it = find(id);
    if (!it) { select(null); return; }
    const kind = kindOf(id), body = ui.shBody, fixed = id === "cam0" || id === "bg0";
    body.replaceChildren();
    ui.shDel.hidden = ui.shHere.hidden = fixed;
    const at = fixed ? "בפתיחה" : fmtT(it.t);
    if (kind === "camera") {
      ui.shTitle.textContent = `מצלמה · ${at}`;
      body.append(
        chips("מסגרת", [["body", "מלא"], ["close", "קרוב"]], isCustom(it) ? null : it.shot, (v) => { it.shot = v; it.zoom = 1; it.panX = 0; it.panY = 0; }),
        slider("זום", 0.5, 3, 0.05, it.zoom ?? 1, (v) => { it.zoom = v; }, ["רחוק", "קרוב"]),
        slider("הזזה לצדדים", -0.5, 0.5, 0.01, it.panX || 0, (v) => { it.panX = v; }, ["שמאלה", "ימינה"]),
        slider("גובה", -0.5, 0.5, 0.01, it.panY || 0, (v) => { it.panY = v; }, ["למטה", "למעלה"]),
      );
      if (!fixed) body.append(
        chips("מעבר", [[0, "חיתוך"], [300, "0.3 ש׳"], [600, "0.6 ש׳"], [1000, "1 ש׳"], [2000, "2 ש׳"], [4000, "4 ש׳"]], it.move, (v) => { it.move = v; }),
        chips("תנועה", [["smooth", "רכה"], ["linear", "קבועה"]], it.ease, (v) => { it.ease = v; }),
      );
    } else if (kind === "effects") {
      ui.shTitle.textContent = `אפקט · ${at}`;
      body.append(chips("סוג", Object.entries(EFFECTS).map(([k, v]) => [k, v.name]), it.type, (v) => {
        it.type = v; it.dur = EFFECTS[v].dur;
        if ((v === "enter" || v === "exit") && !it.dir) it.dir = "right";
      }));
      if (it.type === "enter" || it.type === "exit") body.append(chips("כיוון", Object.entries(DIRS), it.dir, (v) => { it.dir = v; }));
      body.append(
        chips("משך", [[300, "0.3 ש׳"], [600, "0.6 ש׳"], [900, "0.9 ש׳"], [1500, "1.5 ש׳"], [2000, "2 ש׳"], [3000, "3 ש׳"]], it.dur, (v) => { it.dur = v; }),
        chips("עוצמה", [[0.5, "עדין"], [1, "רגיל"], [1.5, "חזק"]], it.strength, (v) => { it.strength = v; }),
      );
    } else if (kind === "media") {
      ui.shTitle.textContent = `תמונה · ${at}`;
      const spot = Object.keys(SPOTS).find((k) => Math.abs(SPOTS[k].x - it.x) < 0.01 && Math.abs(SPOTS[k].y - it.y) < 0.01) ?? null;
      body.append(
        imageField(it, false),
        chips("משך", [[1000, "1 ש׳"], [2000, "2 ש׳"], [3000, "3 ש׳"], [5000, "5 ש׳"], [8000, "8 ש׳"]], it.dur, (v) => { it.dur = v; }),
        chips("כניסה", Object.entries(ANIMS), it.anim, (v) => { it.anim = v; if (v === "slide" && !it.dir) it.dir = "right"; }),
      );
      if (it.anim === "slide") body.append(chips("כיוון", Object.entries(SLIDE_DIRS), it.dir, (v) => { it.dir = v; }));
      body.append(
        chips("מיקום", Object.entries(SPOTS).map(([k, v]) => [k, v.name]), spot, (v) => { it.x = SPOTS[v].x; it.y = SPOTS[v].y; }),
        slider("גודל", 0.1, 1.2, 0.01, it.w, (v) => { it.w = v; }, ["קטן", "גדול"]),
        slider("סיבוב", -30, 30, 1, it.rot || 0, (v) => { it.rot = v; }, ["↺", "↻"]),
        chips("סגנון", [["plain", "רגיל"], ["sticker", "סטיקר"]], it.style, (v) => { it.style = v; }),
        chips("שכבה", [["front", "לפני אלירן"], ["back", "מאחורי אלירן"]], it.layer === "back" ? "back" : "front", (v) => { it.layer = v; }),
        el("p", "ed-tip", "אפשר גם לגרור את התמונה על המסך, ולצבוט בשתי אצבעות כדי לשנות את הגודל."),
      );
    } else {
      ui.shTitle.textContent = `רקע · ${at}`;
      body.append(videoField(it));
      if (it.vid) body.append(...videoOptions(it));
      else body.append(imageField(it, true));
      if (it.img && !it.vid) body.append(
        chips("התאמה", [["cover", "ממלאת את המסך"], ["contain", "כולה, צבע מסביב"]], it.fit === "contain" ? "contain" : "cover", (v) => { it.fit = v; }),
        chips("תנועה", [[false, "סטטית"], [true, "זום איטי"]], !!it.kb, (v) => { it.kb = v; }),
      );
      const wrap = el("div", "ed-field"), row = el("div", "ed-swatches");
      wrap.append(el("span", "ed-lbl2", it.img || it.vid ? "צבע מסביב" : "צבע"), row);
      for (const c of COLORS) {
        const b = el("button", "sw");
        b.style.background = c.color;
        b.title = b.ariaLabel = c.name;
        b.setAttribute("aria-pressed", String(c.color.toLowerCase() === it.color.toLowerCase()));
        b.onclick = () => { const before = snap(); it.color = c.color; changed(before); sheet(); };
        row.append(b);
      }
      body.append(wrap);
      if (!fixed) body.append(chips("מעבר", [[0, "חיתוך"], [300, "0.3 ש׳"], [1000, "1 ש׳"]], it.fade, (v) => { it.fade = v; }));
    }
  }

  // ---- images (layers.js) ------------------------------------------------------------------------------------------
  // Picked from the phone, kept in IndexedDB ("media:<id>", never uploaded), decoded once into S.bmp.
  const thumbOf = (bmp) => {
    const c = document.createElement("canvas"), s = 64 / Math.max(bmp.width, bmp.height);
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  };
  async function loadMedia(ids) {
    for (const id of ids) {
      if (S.bmp.has(id) || S.videos.has(id)) continue;
      let m = null;
      try { m = await ctx.media.get(id); } catch (e) { console.warn("media", id, e); }
      if (m?.kind === "video") { await loadVideo(id, m.blob); continue; }
      let bmp = null;
      try { if (m?.blob) bmp = await decode(m.blob); } catch (e) { console.warn("media", id, e); }
      S.bmp.set(id, bmp);
      if (bmp) S.thumbs.set(id, thumbOf(bmp));
    }
  }
  // A background video (video.js): the source (exact frames), a thumbnail of its first frame, its sound (in the
  // background; the mix follows). -> the source, or throws (the reason in e.message, see videoError).
  async function loadVideo(id, blob) {
    const s0 = S;
    let src = null;
    try {
      if (!blob) throw new Error("missing");
      src = await VideoSource.open(blob);
      const f = await src.frameAt(0), c = document.createElement("canvas"), k = 64 / Math.max(src.w, src.h);
      c.width = Math.max(1, Math.round(src.w * k)); c.height = Math.max(1, Math.round(src.h * k));
      const g = c.getContext("2d");
      drawVideo(g, f, src.rot, 0, 0, c.width, c.height);
      if (S !== s0) { src.close(); return null; }
      S.thumbs.set(id, c.toDataURL("image/png"));
      S.videos.set(id, src);
    } catch (e) {
      console.warn("video", id, e);
      src?.close();
      if (S === s0) S.videos.set(id, null);
      throw e;
    }
    if (src.audio) {
      const sr = S.buffer?.sampleRate || ctx.getAudio()?.sampleRate || 48000;
      audioOf(blob, sr).then((buf) => { if (S === s0 && S.videos.get(id) === src) { S.sounds.set(id, buf); S.mixKey = null; remix(); } });
    }
    return src;
  }
  const videoError = (e) => {
    const m = String(e?.message || "");
    if (m === "no-decoder") return "הדפדפן הזה לא יודע לפענח וידאו (WebCodecs). לפתוח את הדף ב-Chrome מעודכן.";
    if (m === "not-mp4" || m === "no-video") return "לא הצלחתי לקרוא את הווידאו. לבחור קובץ MP4 או MOV (כמו שהטלפון מצלם).";
    if (m.startsWith("codec:")) return `הטלפון לא יודע לפענח את הווידאו הזה (${m.slice(6)}). לבחור וידאו קטן יותר, עד 1080p, ב-H.264.`;
    return "לא הצלחתי לפתוח את הווידאו.";
  };
  // Opens the phone's picker -> {id, type} of the new media, or null (cancelled / unreadable / no room).
  function pickImage() {
    return new Promise((resolve) => {
      const inp = ui.pick;
      inp.value = "";
      inp.onchange = async () => { inp.onchange = inp.oncancel = null; const f = inp.files?.[0]; resolve(f ? await addMedia(f) : null); };
      inp.oncancel = () => { inp.onchange = inp.oncancel = null; resolve(null); };
      inp.click();
    });
  }
  async function addMedia(file) {
    if (!S) return null;
    ctx.say("טוען תמונה…");
    let bmp;
    try { bmp = await decode(file); } catch (e) {
      console.warn(e); ctx.say("לא הצלחתי לפתוח את התמונה. לבחור JPG או PNG.", true); return null;
    }
    const id = newId();
    try { await ctx.media.put({ id, blob: file, name: file.name, type: file.type, w: bmp.width, h: bmp.height, at: Date.now() }); }
    catch (e) { console.error(e); bmp.close(); ctx.say("לא הצלחתי לשמור את התמונה בטלפון (אין מקום?).", true); return null; }
    if (!S) { bmp.close(); return null; }
    S.bmp.set(id, bmp); S.thumbs.set(id, thumbOf(bmp));
    const gif = /gif/i.test(file.type);
    ctx.say(gif ? "GIF נכנס כתמונה (הפריים הראשון)." : "");
    if (gif) setTimeout(() => ctx.say(""), 3000);
    return { id, type: file.type || "" };
  }
  // The "תמונה" row of a panel: pick / replace (and for a background, remove).
  function imageField(it, removable) {
    const wrap = el("div", "ed-field"), row = el("div", "chips");
    wrap.append(el("span", "ed-lbl2", "תמונה"), row);
    const b = el("button", "", it.img ? "🖼 החלף תמונה" : "🖼 בחר תמונה");
    b.onclick = async () => {
      pause();
      const got = await pickImage();
      if (!got || !S) return;
      const before = snap(); it.img = got.id; changed(before); sheet();
    };
    row.append(b);
    if (removable && it.img) {
      const x = el("button", "", "✕ בלי תמונה");
      x.onclick = () => { const before = snap(); it.img = undefined; it.fit = undefined; it.kb = undefined; changed(before); sheet(); };
      row.append(x);
    }
    if (it.img && !S.bmp.get(it.img)) row.append(el("span", "ed-warn", "⚠ התמונה לא נמצאה בטלפון"));
    return wrap;
  }
  // ---- background video (version 8, video.js) -----------------------------------------------------------------
  function pickVideo() {
    return new Promise((resolve) => {
      const inp = ui.pickVid;
      inp.value = "";
      inp.onchange = async () => { inp.onchange = inp.oncancel = null; const f = inp.files?.[0]; resolve(f ? await addVideo(f) : null); };
      inp.oncancel = () => { inp.onchange = inp.oncancel = null; resolve(null); };
      inp.click();
    });
  }
  async function addVideo(file) {
    if (!S) return null;
    if (!videoSupported()) { ctx.say(videoError(new Error("no-decoder")), true); return null; }
    ctx.say("טוען וידאו…");
    const id = newId();
    let src;
    try { src = await loadVideo(id, file); } catch (e) { ctx.say(videoError(e), true); S?.videos.delete(id); return null; }
    if (!src || !S) return null;
    try { await ctx.media.put({ id, blob: file, name: file.name, type: file.type, kind: "video", w: src.w, h: src.h, ms: Math.round(src.ms), at: Date.now() }); }
    catch (e) { console.error(e); src.close(); S.videos.delete(id); ctx.say("לא הצלחתי לשמור את הווידאו בטלפון (אין מקום?). לנסות וידאו קצר יותר.", true); return null; }
    const notes = [];
    if (src.big) notes.push(`וידאו גדול (${src.w}×${src.h}): הרנדר יהיה איטי יותר. עדיף עד 1080p.`);
    if (src.hdr) notes.push("הווידאו ב-HDR: הצבעים עלולים לצאת שטוחים או דהויים. עדיף לצלם בלי HDR.");
    S.notes.set(id, notes);
    ctx.say(notes.join(" "));
    if (notes.length) setTimeout(() => ctx.say(""), 6000);
    return { id, src };
  }
  // The "וידאו" row of a background panel: pick / replace / remove.
  function videoField(it) {
    const wrap = el("div", "ed-field"), row = el("div", "chips");
    wrap.append(el("span", "ed-lbl2", "וידאו"), row);
    const b = el("button", "", it.vid ? "🎬 החלף וידאו" : "🎬 בחר וידאו");
    b.onclick = async () => {
      pause();
      const got = await pickVideo();
      if (!got || !S) return;
      const before = snap();
      it.vid = got.id; it.vfrom = 0; it.img = undefined; it.kb = undefined;
      if (!it.layout) it.layout = "full";
      if (it.vol === undefined) it.vol = VOL;
      changed(before); sheet();
    };
    row.append(b);
    if (it.vid) {
      const x = el("button", "", "✕ בלי וידאו");
      x.onclick = () => { const before = snap(); for (const k of ["vid", "vfrom", "layout", "vol", "vx", "vy", "vw", "fit"]) it[k] = undefined; changed(before); sheet(); };
      row.append(x);
    }
    return wrap;
  }
  function videoOptions(it) {
    const src = S.videos.get(it.vid), out = [];
    if (!src) { out.push(el("p", "ed-warn", "⚠ הווידאו לא נמצא בטלפון (או שלא נפתח). לבחור אותו שוב.")); return out; }
    const info = `${fmtT(src.ms).replace(/\.\d$/, "")} · ${src.w}×${src.h}${src.audio ? "" : " · בלי קול"}`;
    out.push(el("p", "ed-tip", info));
    for (const n of S.notes.get(it.vid) || []) out.push(el("p", "ed-warn", n));
    out.push(chips("פריסה", [["full", "מלא"], ["split", "מפוצל (וידאו למעלה)"], ["corner", "בפינה"]], layoutOf(it), (v) => {
      it.layout = v;
      if (v === "corner") for (const k of ["vx", "vy", "vw"]) it[k] ??= CORNER[k];
    }));
    if (layoutOf(it) !== "corner") out.push(chips("התאמה", [["cover", "ממלא"], ["contain", "כולו"]], it.fit === "contain" ? "contain" : "cover", (v) => { it.fit = v; }));
    else out.push(el("p", "ed-tip", "גוררים את חלון הווידאו על המסך, וצובטים בשתי אצבעות כדי לשנות את הגודל."));
    out.push(slider("מאיפה בווידאו", 0, Math.max(100, Math.floor(src.ms / 100) * 100), 100, it.vfrom || 0, (v) => { it.vfrom = v; }, null, (v) => fmtT(v)));
    if (src.ms - (it.vfrom || 0) < (segAt(S.edit, it.t).end === Infinity ? S.dur : segAt(S.edit, it.t).end) - it.t)
      out.push(el("p", "ed-tip", "הווידאו נגמר לפני הקטע: התמונה האחרונה נשארת עד סוף הקטע, בלי קול."));
    if (src.audio) out.push(slider("עוצמת הקול", 0, 100, 5, Math.round((it.vol ?? VOL) * 100), (v) => { it.vol = v / 100; }, ["🔇", "🔊"], (v) => `${v}%`));
    return out;
  }

  ui.addImg.onclick = async () => {
    if (!S || S.rendering) return;
    pause();
    const t = Math.round(Math.min(S.tv, Math.max(0, S.dur - 500)));
    const got = await pickImage();
    if (!got || !S) return;
    const bmp = S.bmp.get(got.id), before = snap();
    // as wide as 60% of the frame, but no taller than half of it
    const w = Math.min(0.6, 0.5 * (16 / 9) * bmp.width / bmp.height);
    // PNG/WebP/GIF are often cut-outs with a transparent background: no sticker frame around them by default
    const style = /png|gif|webp/i.test(got.type) ? "plain" : "sticker";
    const m = { id: newId(), t, dur: Math.max(500, Math.min(2000, S.dur - t)), img: got.id, x: 0.5, y: 0.45,
                w: Math.round(w * 100) / 100, rot: 0, anim: "pop", style, layer: "front" };
    S.edit.media.push(m); changed(before); select(m.id);
  };

  // The preview: background, images behind, Eliran, images in front (layers.js), drawn after every stage render.
  let g2 = null;
  function drawn() {
    if (!S || S.rendering) return;
    g2 ??= ui.comp.getContext("2d", { alpha: false });
    const sel = S.sel && (S.edit.media.some((m) => m.id === S.sel) || kindOf(S.sel) === "bg") ? S.sel : null;
    composite(g2, ui.comp.width, ui.comp.height, S.edit, S.tv, stage.renderer.domElement, S.bmp, { sel }, S.videos);
  }
  // On the preview: tap an image to select it, drag it to move, pinch to resize (the selected image). The gestures
  // are on the whole stage area, so a pinch works when a finger lands beside the (small) preview.
  const pts = new Map(), surface = ui.comp.parentElement;
  let gest = null;
  surface.addEventListener("pointerdown", (e) => {
    if (!S || S.rendering) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    surface.setPointerCapture(e.pointerId);
    if (pts.size === 1) {
      const r = ui.comp.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      // an image first, then the corner video (version 8); else the selected one of them goes on moving
      const hitM = hitImage(S.edit, S.tv, fx, fy, S.bmp), hitV = !hitM && hitVideo(S.edit, S.tv, fx, fy, S.videos);
      const selM = S.edit.media.find((x) => x.id === S.sel);
      const selV = !selM && S.sel && kindOf(S.sel) === "bg" && segAt(S.edit, S.tv).cur.id === S.sel && layoutOf(find(S.sel)) === "corner";
      let m = null, keys = null;
      if (hitM || (!hitV && selM)) { m = hitM || selM; keys = ["x", "y", "w"]; }
      else if (hitV || selV) {
        m = find(hitV ? hitV.id : S.sel); keys = ["vx", "vy", "vw"];
        for (const k of keys) m[k] ??= CORNER[k];
      }
      if (!m) { gest = null; return; }
      pause();
      if (m.id !== S.sel) select(m.id);
      const [kx, ky, kw] = keys;
      gest = { m, kx, ky, kw, before: snap(), x0: e.clientX, y0: e.clientY, mx: m[kx], my: m[ky], w0: m[kw], d0: 0, moved: false };
    } else if (gest && pts.size === 2) {
      const [a, b] = [...pts.values()];
      gest.d0 = Math.hypot(a.x - b.x, a.y - b.y); gest.w0 = gest.m[gest.kw];
    }
  });
  surface.addEventListener("pointermove", (e) => {
    if (!gest || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = gest.m, r = ui.comp.getBoundingClientRect();
    if (pts.size >= 2 && gest.d0 > 0) {
      const [a, b] = [...pts.values()];
      m[gest.kw] = Math.round(Math.min(1.5, Math.max(0.08, gest.w0 * Math.hypot(a.x - b.x, a.y - b.y) / gest.d0)) * 1000) / 1000;
    } else if (pts.size === 1) {
      const dx = e.clientX - gest.x0, dy = e.clientY - gest.y0;
      if (!gest.moved && Math.hypot(dx, dy) < 6) return;
      m[gest.kx] = Math.round(Math.min(1.2, Math.max(-0.2, gest.mx + dx / r.width)) * 1000) / 1000;
      m[gest.ky] = Math.round(Math.min(1.2, Math.max(-0.2, gest.my + dy / r.height)) * 1000) / 1000;
    }
    gest.moved = true;
    S.edit.updated = Date.now(); showSaved("dirty");
  });
  const compUp = (e) => {
    pts.delete(e.pointerId);
    if (!gest) return;
    if (pts.size === 1) { // the pinch ended with one finger left: go on dragging from here
      const [p] = [...pts.values()];
      Object.assign(gest, { x0: p.x, y0: p.y, mx: gest.m[gest.kx], my: gest.m[gest.ky], d0: 0 });
      return;
    }
    if (pts.size === 0) {
      const g = gest; gest = null;
      if (g.moved && S) { changed(g.before); if (S.sel === g.m.id) sheet(); }
    }
  };
  surface.addEventListener("pointerup", compUp);
  surface.addEventListener("pointercancel", compUp);

  // ---- render -----------------------------------------------------------------------------------------------------
  let can = null;
  ui.render.onclick = async () => {
    if (!S) return;
    pause();
    await flushSave();
    if (!S) return;
    ui.rSheet.hidden = false;
    ui.rBar.hidden = true;
    ui.rGo.hidden = false; ui.rGo.disabled = true;
    ui.rNote.textContent = "בודק מה הטלפון יודע לקודד…";
    drawOpts();
    can ??= await support().catch(() => ({ video: false }));
    window.__rec.renderSupport = can;
    if (!can.video) {
      ui.rNote.textContent = "הדפדפן הזה לא יודע לקודד H.264 (WebCodecs), אז אין כאן רנדר. אפשר במקום זה \"↻ נגן מחדש\" ואז \"● הקלט לוידאו חדש\" (בלי העריכה), או לפתוח את הדף ב-Chrome מעודכן.";
      return;
    }
    ui.rGo.disabled = false;
    ui.rNote.textContent = (S.buffer ? "" : "אין קול בהקלטה הזאת. ") +
      (S.buffer && can.audio !== "aac" ? (can.audio ? "הקול יישמר ב-Opus (אין כאן קידוד AAC). " : "אין כאן קידוד קול: הווידאו ייצא בלי קול. ") : "") +
      "הרנדר עובר פריים אחרי פריים, ולכן יוצא חלק גם בטלפון איטי. צריך להשאיר את הדף פתוח עד הסוף.";
  };
  function drawOpts() {
    ui.rOpts.replaceChildren(
      optChips("גודל", [["720", "720×1280"], ["1080", "1080×1920"]], "size"),
      optChips("פריימים בשנייה", [[30, "30"], [60, "60"]], "fps"),
      optChips("איכות", [[1, "רגילה"], [2, "חדה (×2, איטי יותר)"]], "ss"),
    );
  }
  function optChips(label, values, key) {
    const wrap = el("div", "ed-field"), row = el("div", "chips");
    wrap.append(el("span", "ed-lbl2", label), row);
    for (const [v, text] of values) {
      const b = el("button", "", text);
      b.setAttribute("aria-pressed", String(opts[key] === v));
      b.onclick = () => { if (S?.rendering) return; opts[key] = v; drawOpts(); };
      row.append(b);
    }
    return wrap;
  }
  let job = null;
  ui.rCancel.onclick = () => { if (job) job.cancel = true; else ui.rSheet.hidden = true; };
  ui.rGo.onclick = async () => {
    if (!S || S.rendering) return;
    S.rendering = true;
    job = { cancel: false };
    ui.rGo.hidden = true;
    ui.rBar.hidden = false;
    ui.rFill.style.width = "0%";
    ui.rText.textContent = "מתחיל…";
    ui.rCancel.textContent = "בטל רנדר";
    let wake = null;
    try { wake = await navigator.wakeLock?.request("screen"); } catch { /* not critical */ }
    const t0 = performance.now(), src = S.rec;
    try {
      const res = await renderTake({
        stage, pose: S.pose, edit: S.edit, take: S.data, voice: ctx.voiceSettings, bitmaps: S.bmp, videos: S.videos,
        opts: { ...opts, signal: job, onProgress: ({ frame, frames, fps }) => {
          ui.rFill.style.width = `${(100 * frame / frames).toFixed(1)}%`;
          const left = (frames - frame) / Math.max(0.1, fps) * 1000;
          ui.rText.textContent = `פריים ${frame} / ${frames} · ${fps.toFixed(0)} בשנייה · נשאר בערך ${fmtT(left).replace(/\.\d$/, "")}`;
        } },
      });
      const at = Date.now();
      const rec = {
        id: String(at), name: `${src.name} (ערוך)`.slice(0, 60), base: `${src.base}-edit-${SIZES[opts.size][1]}p${res.fps}`, at,
        ms: res.ms, kind: "render", from: src.id, video: res.blob, videoType: "video/mp4", perf: src.perf, dets: src.dets,
        audio: !!res.audio, edit: structuredClone(S.edit),
        render: { w: res.w, h: res.h, fps: res.fps, ss: opts.ss, codec: res.codec, audio: res.audio, secs: (performance.now() - t0) / 1000 },
      };
      window.__rec.lastRender = { ...rec.render, bytes: res.blob.size, frames: res.frames, ms: res.ms };
      await ctx.storeTake(rec);
      // the draft is now exported (until it changes again): the takes list moves it out of "טיוטות"
      src.exported = S.edit.updated || at;
      src.edit = structuredClone(S.edit);
      await ctx.putTake(src).catch((e) => console.warn("mark exported", e));
      ui.rSheet.hidden = true;
      ctx.openResult(rec);
    } catch (e) {
      console.error(e);
      if (e?.message === "cancel") ui.rSheet.hidden = true;
      else { ui.rText.textContent = `הרנדר נכשל (${e?.name || "Error"}: ${e?.message || ""}).`; ui.rGo.hidden = false; }
      window.__rec.lastRenderError = String(e?.message || e);
    } finally {
      try { await wake?.release(); } catch { /* released */ }
      job = null;
      if (S) S.rendering = false;
      ui.rCancel.textContent = "סגור";
      stage.vrm?.springBoneManager?.reset();
    }
  };

  const api = { open, close, tick, drawn, bodyChanged, voiceChanged, flushSave, get active() { return !!S; }, get rendering() { return !!S?.rendering; }, get state() { return S; } };
  return api;
}
