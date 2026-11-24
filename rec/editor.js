// The editor on a take (docs/phone_recording.md, "Editor"): Eliran on top, three strips below (מצלמה / אפקטים / רקע)
// like CapCut (the layout the user picked, 25.11). Time runs right to left (Hebrew), the playhead stays in the middle
// and the strips move under it: drag to scrub, tap a block to edit it below the strips, drag a selected block to move
// it. The edit (edit.js) is saved with the take on every change; "רנדר" makes the video offline (render.js).
// Text in Hebrew; values from the take are set with textContent.
import { readTake, PoseTrack } from "./take.js?v=4";
import { FaceRig } from "./mapping.js?v=4";
import { BG } from "./avatar.js?v=4";
import { newEdit, checkEdit, newId, sceneAt, applyScene, cameraAt, COLORS, EFFECTS, DIRS, SHOTS } from "./edit.js?v=4";
import { renderTake, support, SIZES } from "./render.js?v=4";

const $ = (id) => document.getElementById(id);
const fmtT = (ms) => {
  const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ROW = { camera: 0, effects: 1, bg: 2 };
const RULER = 18, ROW_H = 34;
const light = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return r * 0.3 + g * 0.59 + b * 0.11 > 150; };

// ctx: {stage, getAudio() -> AudioContext, putTake(rec), storeTake(rec), openResult(rec), say(text, bad), onClose()}
export function createEditor(ctx) {
  const { stage } = ctx;
  const ui = {
    root: $("editor"), title: $("ed-title"), play: $("ed-play"), time: $("ed-time"), undo: $("ed-undo"),
    zin: $("ed-zin"), zout: $("ed-zout"), tl: $("ed-tl"), content: $("ed-content"), add: $("ed-add"),
    addCam: $("ed-add-cam"), addFx: $("ed-add-fx"), addBg: $("ed-add-bg"),
    sheet: $("ed-sheet"), shTitle: $("ed-sh-title"), shBody: $("ed-sh-body"), shHere: $("ed-sh-here"),
    shDel: $("ed-sh-del"), shOk: $("ed-sh-ok"), close: $("ed-close"), render: $("ed-render"),
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
    S = { rec, data, edit, pose: new PoseTrack(data, rig), dur: data.header.durationMs, tv: 0, k: 0.06,
          playing: false, sel: null, undo: [], buffer: null, src: null, rendering: false };
    if (data.audio) {
      try { const ac = ctx.getAudio(); await ac.resume(); S.buffer = await ac.decodeAudioData(await data.audio.arrayBuffer()); }
      catch (e) { console.warn("editor audio", e); }
    }
    ctx.say("");
    ui.title.textContent = rec.name;
    ui.root.hidden = false;
    document.body.classList.add("editing");
    stage.vrm.springBoneManager?.reset();
    select(null);
    draw();
    window.__rec.editor = api;
  }
  function close() {
    if (!S || S.rendering) return;
    pause();
    flushSave();
    S = null;
    ui.root.hidden = true;
    document.body.classList.remove("editing");
    stage.place(null);
    stage.background(BG);
    stage.frame(stage.framing);
    stage.vrm?.springBoneManager?.reset();
    ctx.onClose();
  }
  ui.close.onclick = close;

  // ---- saving (debounced) and undo ------------------------------------------------------------------------------
  let saveTimer = null;
  function changed(snapshot) {
    if (snapshot) { S.undo.push(snapshot); if (S.undo.length > 50) S.undo.shift(); }
    S.edit.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
    draw();
  }
  function flushSave() {
    if (!S || saveTimer === null) return;
    clearTimeout(saveTimer); saveTimer = null;
    S.rec.edit = structuredClone(S.edit);
    ctx.putTake(S.rec).catch((e) => { console.error(e); ctx.say("לא הצלחתי לשמור את העריכה.", true); });
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
    if (S.buffer && ac) {
      const when = ac.currentTime + 0.06, off = (S.tv - (S.data.header.audio?.startMs ?? 0)) / 1000;
      const src = ac.createBufferSource();
      src.buffer = S.buffer;
      src.connect(ac.destination);
      if (off >= 0) src.start(when, off); else src.start(when - off, 0);
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
    const rows = ["camera", "effects", "bg"].map((name) => {
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
    };
    // camera: the start view, then each key with its move
    const keys = [...edit.camera].sort((a, b) => a.t - b.t);
    item(0, "cam0", 0, Math.min(keys[0]?.t ?? dur, 1500) * k, "פתיחה: " + camName(edit.cam0), "#8f63c2", "#fff");
    for (const key of keys) item(0, key.id, key.t, (key.move || 0) * k, `${camName(key)}${key.move ? "" : " ✂"}`, "#C77DFF");
    // effects
    for (const e of edit.effects) item(1, e.id, e.t, e.dur * k, EFFECTS[e.type]?.name + (e.dir && (e.type === "enter" || e.type === "exit") ? " " + DIRS[e.dir] : ""), "#FF8FCF");
    // background: segments to the next change
    const bgs = [...edit.bg].sort((a, b) => a.t - b.t);
    const segs = [{ id: "bg0", t: 0, color: edit.bg0 }, ...bgs];
    segs.forEach((b, i) => {
      const end = segs[i + 1]?.t ?? dur, name = COLORS.find((x) => x.color.toLowerCase() === b.color.toLowerCase())?.name || b.color;
      item(2, b.id, b.t, (end - b.t) * k, name, b.color, light(b.color) ? "#16101C" : "#FFF6EE");
    });
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
    if (id === "bg0") return { id: "bg0", t: 0, get color() { return e.bg0; }, set color(v) { e.bg0 = v; } };
    return e.camera.find((x) => x.id === id) || e.effects.find((x) => x.id === id) || e.bg.find((x) => x.id === id) || null;
  }
  const kindOf = (id) => (id === "cam0" || S.edit.camera.some((x) => x.id === id) ? "camera"
    : S.edit.effects.some((x) => x.id === id) ? "effects" : "bg");
  function select(id) {
    if (S) S.sel = id;
    ui.sheet.hidden = !id;
    ui.add.hidden = !!id;
    if (id) sheet();
    draw();
  }
  ui.shOk.onclick = () => select(null);
  ui.shDel.onclick = () => {
    const id = S.sel; if (!id || id === "cam0" || id === "bg0") return;
    const before = snap();
    for (const list of [S.edit.camera, S.edit.effects, S.edit.bg]) { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); }
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
    const before = snap(), cur = sceneAt(S.edit, S.tv, stage).bg.toLowerCase();
    const color = (COLORS.find((c) => c.color.toLowerCase() !== cur && c.color !== BG) || COLORS[1]).color;
    const b = { id: newId(), t: Math.round(S.tv), color, fade: 0 };
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
  function slider(label, min, max, step, value, set, ends) {
    const wrap = el("div", "ed-field ed-slide"), input = el("input");
    Object.assign(input, { type: "range", min, max, step, value });
    input.dir = "ltr";
    let before = null;
    input.onpointerdown = () => { before = snap(); };
    input.oninput = () => { if (!before) before = snap(); set(Number(input.value)); S.edit.updated = Date.now(); };
    input.onchange = () => { changed(before); before = null; };
    const l = el("span", "ed-lbl2", label);
    const r = el("div", "ed-ends");
    if (ends) r.append(el("span", "", ends[0]), input, el("span", "", ends[1])); else r.append(input);
    wrap.append(l, r);
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
    } else {
      ui.shTitle.textContent = `רקע · ${at}`;
      const wrap = el("div", "ed-field"), row = el("div", "ed-swatches");
      wrap.append(el("span", "ed-lbl2", "צבע"), row);
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

  // ---- render -----------------------------------------------------------------------------------------------------
  let can = null;
  ui.render.onclick = async () => {
    if (!S) return;
    pause();
    flushSave();
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
        stage, pose: S.pose, edit: S.edit, take: S.data,
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

  const api = { open, close, tick, get active() { return !!S; }, get rendering() { return !!S?.rendering; }, get state() { return S; } };
  return api;
}
