// The recording page flow (docs/phone_recording.md): pick VRM (once, kept in IndexedDB) -> camera + mic ->
// live tracking -> record a take (start/stop, up to MAX_MS) = the video + a performance file (take.js) -> takes list
// (play, share, save, delete) -> "נגן מחדש" drives Eliran from the file, and can record that to a new video ->
// "ערוך" opens the timeline editor on the take (editor.js), which renders the edit offline to an MP4 (render.js).
// Text in Hebrew; values from files are set with textContent.
import { createStage } from "./avatar.js?v=4";
import { createTracker } from "./tracking.js?v=4";
import { FaceRig } from "./mapping.js?v=4";
import { startRecording, pickType, frameDrawn } from "./recorder.js?v=4";
import { TakeWriter, readTake, createReplay, EXT } from "./take.js?v=4";
import { createEditor } from "./editor.js?v=4";

// Must match <meta name="rec-version"> in index.html. A different value = the phone mixed cached files from two
// versions: reload once with a fresh URL (index.html then comes fresh and asks for matching files).
const REC_VERSION = "4";
if (document.querySelector('meta[name="rec-version"]')?.content !== REC_VERSION) {
  const key = "rec-reload-" + REC_VERSION;
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    location.replace(location.pathname + "?r=" + Date.now());
  }
  throw new Error("stale index.html");
}
const MAX_MS = 90_000; // longest take (25.11: 90 s until the user decides otherwise)
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const $ = (id) => document.getElementById(id);
const ui = {
  view: $("view"), cam: $("cam"), status: $("status"), fps: $("fps"), dot: $("rec-dot"), hint: $("hint"),
  pick: $("pick"), input: $("pick-input"), start: $("start"), record: $("record"), chips: $("chips"),
  micRetry: $("mic-retry"), mirror: $("t-mirror"), showCam: $("t-cam"), fBody: $("f-body"), fClose: $("f-close"),
  calib: $("calib"), swap: $("swap"), takesBtn: $("takes-btn"),
  result: $("result"), playback: $("playback"), meta: $("meta"), share: $("share"), save: $("save"), savePerf: $("save-perf"),
  resultReplay: $("result-replay"), resultEdit: $("result-edit"), again: $("again"),
  takes: $("takes"), takesList: $("takes-list"), takesClose: $("takes-close"), takesNote: $("takes-note"),
  rpBar: $("replay-bar"), rpTitle: $("rp-title"), rpAgain: $("rp-again"), rpRec: $("rp-rec"), rpStop: $("rp-stop"),
};

function say(text, bad = false) {
  ui.status.hidden = !text;
  ui.status.textContent = text || "";
  ui.status.classList.toggle("bad", bad);
}
function show(...els) { for (const el of [ui.pick, ui.start, ui.record]) el.hidden = !els.includes(el); }
let shown = []; // the main button for the live flow, restored when a replay closes
function showMain(...els) { shown = els; if (!rp) show(...els); }

// ---- the model file, kept on this phone only -------------------------------------------------------------
// Version 2 (25.11) adds "takes": {id, name, base, at, ms, kind: "live"|"replay"|"render", from?, video, videoType, perf,
// dets, audio, edit? (edit.js, saved by the editor), render? ({w, h, fps, ss, codec, audio, secs} of a rendered take)}.
const DB = "eliran-rec", STORE = "files", TAKES = "takes";
function idb(mode, fn, store = STORE) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(TAKES)) db.createObjectStore(TAKES, { keyPath: "id" });
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("blocked"));
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      const tx = db.transaction(store, mode), req = fn(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); resolve(req?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const saveModel = (file) => idb("readwrite", (s) => s.put({ blob: file, name: file.name, at: Date.now() }, "vrm"));
const readModel = () => idb("readonly", (s) => s.get("vrm"));
const putTake = (t) => idb("readwrite", (s) => s.put(t), TAKES);
const allTakes = async () => ((await idb("readonly", (s) => s.getAll(), TAKES)) || []).sort((a, b) => b.at - a.at);
const delTake = (id) => idb("readwrite", (s) => s.delete(id), TAKES);

// ---- state ------------------------------------------------------------------------------------------------
const stage = createStage(ui.view);
let rig = null, tracker = null, media = null, wake = null, busy = false, lastUrl = null, current = null, modelInfo = null;
let take = null, liveRec = null; // the take being recorded: TakeWriter + recorder controller
let rp = null;                   // replay state (startReplay)
const stats = { frames: 0, dets: 0, detMs: 0, t: performance.now(), face: false };
// For local tests. __rec.trace = [] collects {src, t, target, head} after every face update (live while recording,
// and in replay), to compare the two.
window.__rec = { stage, get rig() { return rig; }, get tracker() { return tracker; }, get replay() { return rp; }, stats, trace: null };
const trace = (src, r, t) => window.__rec.trace?.push({ src, t, target: { ...r.target }, head: { ...r.head } });

async function loadModel(blob, name) {
  say("טוען את אלירן…");
  try {
    const buf = await blob.arrayBuffer();
    const vrm = await stage.load(buf);
    const mirror = rig ? rig.mirror : true;
    rig = new FaceRig(vrm);
    rig.mirror = mirror;
    modelInfo = { name: name || "VRM", bytes: blob.size, expressions: Object.keys(vrm.expressionManager.expressionMap), driven: rig.driven };
    ui.chips.hidden = false;
    if (media) { showMain(ui.record); say(""); } else { showMain(ui.start); say(""); }
    ui.hint.hidden = false;
    ui.hint.textContent = `מודל: ${name || "VRM"} · ${(blob.size / 1e6).toFixed(1)}MB · ${rig.driven.length} הבעות מחוברות`;
    return true;
  } catch (e) {
    console.error(e);
    say(e.message === "not-vrm" ? "הקובץ הזה לא VRM. צריך קובץ ‎.vrm‎ של אלירן." : "לא הצלחתי לטעון את המודל.", true);
    showMain(ui.pick);
    return false;
  }
}

ui.pick.onclick = ui.swap.onclick = () => ui.input.click();
ui.input.onchange = async () => {
  const file = ui.input.files?.[0];
  ui.input.value = "";
  if (!file) return;
  if (await loadModel(file, file.name)) {
    try { await saveModel(file); navigator.storage?.persist?.(); } catch (e) { console.warn("could not keep the model", e); }
  }
};

// ---- camera, mic, tracking ----------------------------------------------------------------------------------
// Camera and mic are asked for separately (25.11, phone bug): one combined call fails as a whole when only the mic is
// refused (site setting, or Chrome has no Android microphone permission), and the page then said "no permission"
// although the camera was allowed. Now a refused mic means recording without sound, and every error names the device.
const VIDEO = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
const HOWTO = {
  camera: "בכרום: לחיצה על הסמל שליד הכתובת, \"הרשאות\", ולאפשר מצלמה. אם זה לא עוזר: הגדרות הטלפון, אפליקציות, Chrome, הרשאות, מצלמה.",
  mic: "בכרום: לחיצה על הסמל שליד הכתובת, \"הרשאות\", ולאפשר מיקרופון. אם זה לא עוזר: הגדרות הטלפון, אפליקציות, Chrome, הרשאות, מיקרופון.",
};
function deviceError(device, e) {
  const name = e?.name || "Error", what = device === "camera" ? "למצלמה" : "למיקרופון";
  if (name === "NotAllowedError" || name === "SecurityError") return `אין הרשאה ${what} (${name}). ${HOWTO[device]}`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `לא נמצא${device === "camera" ? "ה מצלמה" : " מיקרופון"} (${name}).`;
  if (name === "NotReadableError" || name === "AbortError") return `${device === "camera" ? "המצלמה תפוסה" : "המיקרופון תפוס"} באפליקציה אחרת (${name}). לסגור אותה ולנסות שוב.`;
  return `לא הצלחתי להפעיל ${device === "camera" ? "את המצלמה" : "את המיקרופון"} (${name}).`;
}
let micError = null;
async function openMic() {
  try {
    const a = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of a.getAudioTracks()) media.addTrack(t);
    micError = null;
  } catch (e) {
    console.warn("mic", e);
    micError = e;
  }
  showMicState();
}
function showMicState() {
  ui.micRetry.hidden = !micError;
  if (!liveRec) ui.record.textContent = `● התחל הקלטה${micError ? " (בלי קול)" : ""}`;
  if (micError) { ui.hint.hidden = false; ui.hint.textContent = "מקליט בלי קול: " + deviceError("mic", micError); }
}

ui.start.onclick = async () => {
  if (busy) return;
  busy = true;
  ui.start.disabled = true;
  let step = "camera";
  try {
    if (!media) {
      say("מבקש גישה למצלמה…");
      media = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
      step = "mic";
      say("מבקש גישה למיקרופון…");
      await openMic();
      step = "camera";
      ui.cam.srcObject = media;
      await ui.cam.play().catch((e) => console.warn("preview play", e)); // muted, so this should not block
    }
    step = "tracker";
    say("טוען מעקב פנים… (בפעם הראשונה כמה שניות)");
    tracker = await createTracker();
    say("");
    showMain(ui.record);
    showMicState();
    keepAwake();
  } catch (e) {
    console.error(step, e);
    if (step === "tracker") {
      say(`המצלמה עובדת, אבל מעקב הפנים לא נטען (${e?.name || "Error"}). לבדוק חיבור לאינטרנט וללחוץ שוב.`, true);
    } else {
      media?.getTracks().forEach((t) => t.stop());
      media = null;
      say(deviceError("camera", e), true);
    }
  } finally {
    busy = false;
    ui.start.disabled = false;
  }
};
ui.micRetry.onclick = async () => {
  if (busy || !media) return;
  busy = true;
  await openMic();
  busy = false;
  if (!micError) { ui.hint.textContent = "המיקרופון עובד ✓"; }
};

async function keepAwake() {
  try { wake = await navigator.wakeLock?.request("screen"); } catch { /* not critical */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && media) keepAwake(); });

// ---- toggles ------------------------------------------------------------------------------------------------
// Changes during a take are written to the performance file as events (take.js), so a replay follows them.
function toggle(btn, on) { btn.setAttribute("aria-pressed", String(on)); return on; }
ui.mirror.onclick = () => {
  if (!rig || rp) return;
  rig.mirror = toggle(ui.mirror, !rig.mirror);
  take?.event("mirror", { value: rig.mirror });
};
ui.showCam.onclick = () => { ui.cam.hidden = !toggle(ui.showCam, ui.cam.hidden); };
function setFrame(mode) {
  stage.frame(mode);
  toggle(ui.fBody, mode === "body"); toggle(ui.fClose, mode === "close");
  if (!rp) take?.event("frame", { value: mode });
}
ui.fBody.onclick = () => setFrame("body");
ui.fClose.onclick = () => setFrame("close");
ui.calib.onclick = () => {
  if (rp) return;
  if (!rig?.raw) { say("לא רואה פנים כרגע. הסתכל ישר למצלמה עם פנים רגילות ונסה שוב.", true); setTimeout(() => say(""), 2500); return; }
  rig.calibrate();
  take?.event("calib", { offset: { ...rig.offset }, base: { ...rig.base } });
  say("כויל ✓ הפנים האלה הן עכשיו \"רגיל\""); setTimeout(() => say(""), 1500);
};

// ---- record a take ------------------------------------------------------------------------------------------
// Start/stop (stops by itself at MAX_MS). Each take = the regular video + a performance file, kept in IndexedDB.
function takeInfo() {
  return {
    settings: { mirror: rig.mirror, framing: stage.framing, calibration: { offset: { ...rig.offset }, base: { ...rig.base } } },
    model: modelInfo,
    tracker: { lib: "@mediapipe/tasks-vision@1.2.3", delegate: tracker?.delegate, video: { w: ui.cam.videoWidth, h: ui.cam.videoHeight } },
    stage: { w: ui.view.width, h: ui.view.height, fov: stage.camera.fov, framing: stage.framing },
  };
}
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
// Mixed Hebrew/numbers/Latin parts joined with "·": each part isolated (FSI..PDI) so RTL does not reorder the dots.
const FSI = String.fromCharCode(0x2068), PDI = String.fromCharCode(0x2069);
const isolate = (parts) => parts.filter(Boolean).map((x) => FSI + x + PDI).join(" · ");
const niceDate = (at) => new Date(at).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
function lockUi(on) {
  for (const b of [ui.swap, ui.takesBtn, ui.micRetry]) b.disabled = on;
}

ui.record.onclick = async () => {
  if (liveRec) { liveRec.stop(); return; }
  if (busy || !media || !rig) return;
  let ctl;
  try {
    ctl = startRecording(ui.view, media.getAudioTracks()[0], {
      maxMs: MAX_MS, separateAudio: true,
      onTick: (ms) => { ui.dot.textContent = `● ${fmt(ms)} / ${fmt(MAX_MS)}`; ui.record.textContent = `■ עצור (${fmt(ms)})`; },
    });
  } catch (e) {
    console.error(e);
    say("ההקלטה נכשלה בדפדפן הזה.", true);
    return;
  }
  busy = true;
  take = new TakeWriter(ctl.t0, rig, takeInfo());
  liveRec = ctl;
  lockUi(true);
  ui.record.classList.add("rec");
  ui.record.textContent = "■ עצור (0:00)";
  ui.dot.textContent = `● 0:00 / ${fmt(MAX_MS)}`;
  ui.dot.hidden = false;
  try {
    const out = await ctl.done;
    const writer = take;
    take = null;
    say("שומר…");
    const perf = await writer.finish(out);
    const at = Date.now(), base = `eliran-${stamp(new Date(at))}`;
    let n = 1;
    try { n = (await allTakes()).filter((t) => t.kind === "live").length + 1; } catch { /* name only */ }
    const rec = {
      id: String(at), name: `הקלטה ${n}`, base, at, ms: out.ms, kind: "live",
      video: out.video.blob, videoType: out.video.type, perf, dets: writer.frames.length, audio: !!out.audio,
    };
    await storeTake(rec);
    say("");
    openResult(rec);
  } catch (e) {
    console.error(e);
    say("ההקלטה נכשלה בדפדפן הזה.", true);
  } finally {
    take = null; liveRec = null; busy = false;
    lockUi(false);
    ui.dot.hidden = true;
    ui.record.classList.remove("rec");
    showMicState();
  }
};

async function storeTake(rec) {
  try {
    await putTake(rec);
    navigator.storage?.persist?.();
    window.__rec.lastTake = { id: rec.id, ms: rec.ms, dets: rec.dets, perfBytes: rec.perf.size, videoBytes: rec.video.size, videoType: rec.videoType };
  } catch (e) {
    console.error("could not keep the take", e);
    say("לא הצלחתי לשמור את ההקלטה בטלפון (אין מקום?). אפשר עדיין לשמור אותה מכאן.", true);
  }
}

// ---- result sheet (a take: its video, share, save, performance file, replay) ---------------------------------
const extOf = (type) => (type.includes("mp4") ? "mp4" : "webm");
const videoFile = (t) => new File([t.video], `${t.base}.${extOf(t.videoType)}`, { type: t.videoType.split(";")[0] });
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function shareTake(t) {
  const f = videoFile(t);
  if (!(navigator.canShare && navigator.canShare({ files: [f] }))) { download(t.video, f.name); return; }
  navigator.share({ files: [f], title: "אלירן" }).catch((e) => {
    if (e?.name !== "AbortError") say("השיתוף לא נפתח. אפשר \"שמור\" ולשתף מהגלריה.", true);
  });
}
const savePerf = (t) => download(t.perf, `${t.base}.${EXT}`);

function openResult(t) {
  current = t;
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(t.video);
  const f = videoFile(t);
  ui.playback.src = lastUrl;
  ui.save.href = lastUrl;
  ui.save.download = f.name;
  ui.meta.textContent = isolate([t.name, fmt(t.ms), `${(t.video.size / 1e6).toFixed(1)}MB`, t.audio ? "" : "בלי קול", t.videoType]);
  ui.share.hidden = !(navigator.canShare && navigator.canShare({ files: [f] }));
  ui.result.hidden = false;
  ui.playback.play().catch(() => {});
  window.__rec.last = { size: t.video.size, type: t.videoType, ms: t.ms, name: f.name };
}
ui.share.onclick = () => current && shareTake(current);
ui.savePerf.onclick = () => current && savePerf(current);
ui.resultReplay.onclick = () => { if (current) { closeResult(); startReplay(current); } };
ui.resultEdit.onclick = () => { if (current) { closeResult(); openEditor(current); } };
function closeResult() { ui.playback.pause(); ui.result.hidden = true; }
ui.again.onclick = closeResult;

// ---- takes list ---------------------------------------------------------------------------------------------
ui.takesBtn.onclick = () => { ui.takes.hidden = false; renderTakes(); };
ui.takesClose.onclick = () => { ui.takes.hidden = true; };
function btn(text, fn, cls = "") {
  const b = document.createElement("button");
  b.textContent = text; b.onclick = fn; if (cls) b.className = cls;
  return b;
}
async function renderTakes() {
  let list = [];
  try { list = await allTakes(); } catch (e) { console.error(e); }
  ui.takesList.replaceChildren();
  ui.takesNote.textContent = list.length ? `${list.length} הקלטות, שמורות רק בדפדפן הזה בטלפון.` : "אין עדיין הקלטות.";
  for (const t of list) {
    const li = document.createElement("li"), head = document.createElement("div"), name = document.createElement("b");
    const meta = document.createElement("span"), row = document.createElement("div");
    name.textContent = t.name;
    meta.textContent = isolate([niceDate(t.at), fmt(t.ms), t.audio ? "" : "בלי קול",
      t.kind === "render" && t.render ? `ערוך ${t.render.h}p${t.render.fps}` : t.edit ? "יש עריכה" : ""]);
    head.append(name, meta);
    row.className = "chips";
    row.append(
      btn("▶ צפה", () => { ui.takes.hidden = true; openResult(t); }),
      btn("✂ ערוך", () => { ui.takes.hidden = true; openEditor(t); }),
      btn("↻ נגן מחדש", () => { ui.takes.hidden = true; startReplay(t); }),
      btn("שתף", () => shareTake(t)),
      btn("שמור וידאו", () => download(t.video, videoFile(t).name)),
      btn("שמור ביצוע", () => savePerf(t)),
      btn("✎ שם", async () => {
        const n = prompt("שם להקלטה:", t.name);
        if (n && n.trim()) { t.name = n.trim().slice(0, 60); await putTake(t); renderTakes(); }
      }),
      btn("🗑 מחק", async () => {
        if (!confirm(`למחוק את "${t.name}"? אי אפשר לשחזר.`)) return;
        await delTake(t.id); renderTakes();
      }, "danger"),
    );
    li.append(head, row);
    ui.takesList.append(li);
  }
}

// ---- replay ("נגן מחדש"): drive Eliran from a performance file -------------------------------------------------
// Same mapping path as live (a fresh FaceRig restored to the take's start state, fed the recorded detections at their
// times). The mic audio plays in sync. The framing can be changed; "הקלט לוידאו חדש" records the replay to a new take.
let actx = null;
const LEAD_MS = 150; // start a little ahead so the audio can be scheduled exactly
async function startReplay(t) {
  if (!stage.vrm || liveRec) return;
  stopReplay();
  say("טוען את הביצוע…");
  let data;
  try { data = await readTake(t.perf); } catch (e) { console.error(e); say("קובץ הביצוע לא נקרא.", true); return; }
  rp = { t, data, rig: new FaceRig(stage.vrm), replay: null, p0: null, tv: 0, buffer: null, src: null, dest: null, recCtl: null };
  if (data.audio) {
    try {
      actx ??= new AudioContext();
      await actx.resume();
      rp.buffer = await actx.decodeAudioData(await data.audio.arrayBuffer());
      rp.dest = actx.createMediaStreamDestination();
    } catch (e) { console.warn("replay audio", e); rp.buffer = null; }
  }
  window.__rec.replayHeader = data.header;
  say("");
  show();
  ui.rpBar.hidden = false;
  playReplay(false);
}
function playReplay(recording) {
  if (!rp) return;
  rp.src?.stop(); rp.src = null;
  rp.replay = createReplay(rp.data, rp.rig, { onUpdate: (t) => trace("replay", rp.rig, t) });
  rp.ended = false;
  const now = performance.now();
  rp.p0 = now + LEAD_MS;
  if (rp.buffer && actx) {
    // Map the page clock to the audio clock. Recording: the stream gets samples as they are processed (currentTime);
    // listening: what is heard is the output (getOutputTimestamp).
    const ts = !recording && actx.getOutputTimestamp ? actx.getOutputTimestamp() : null;
    const ctxNow = ts?.contextTime ?? actx.currentTime, perfNow = ts?.performanceTime || now;
    const c0 = ctxNow + (rp.p0 - perfNow) / 1000;
    const when = c0 + (rp.data.header.audio?.startMs ?? 0) / 1000;
    const src = actx.createBufferSource();
    src.buffer = rp.buffer;
    src.connect(actx.destination);
    if (rp.dest) src.connect(rp.dest);
    if (when >= actx.currentTime) src.start(when); else src.start(actx.currentTime, actx.currentTime - when);
    rp.src = src;
  }
  updateReplayBar();
}
function updateReplayBar() {
  if (!rp?.replay) return; // still loading the file
  ui.rpTitle.textContent = `${rp.recCtl ? "● מקליט" : "▶ מנגן מחדש"}: ${rp.t.name} · ${fmt(Math.min(rp.tv, rp.replay.durationMs))} / ${fmt(rp.replay.durationMs)}`;
  ui.rpAgain.disabled = ui.rpRec.disabled = !!rp.recCtl;
  ui.rpRec.textContent = rp.recCtl ? "מקליט…" : "● הקלט לוידאו חדש";
}
setInterval(() => rp && updateReplayBar(), 250);
ui.rpAgain.onclick = () => playReplay(false);
ui.rpRec.onclick = () => {
  if (!rp || rp.recCtl || pickType() === null) return;
  const track = rp.dest?.stream.getAudioTracks()[0] ?? null;
  try {
    rp.recCtl = startRecording(ui.view, track, { maxMs: rp.data.header.durationMs + 5000 });
  } catch (e) { console.error(e); say("ההקלטה נכשלה בדפדפן הזה.", true); return; }
  ui.dot.hidden = false; ui.dot.textContent = "● הפעלה מחדש";
  playReplay(true);
};
ui.rpStop.onclick = () => { if (rp?.recCtl) endReplayRecording(); else stopReplay(); };
function endReplayRecording() {
  if (!rp?.recCtl || rp.finishing) return;
  rp.finishing = true;
  rp.recCtl.stop();
  finishReplayRecording();
}

// Called from the loop once the replay passed its end.
function replayEnded() {
  if (rp.ended) return;
  rp.ended = true;
  endReplayRecording();
  updateReplayBar();
}
async function finishReplayRecording() {
  const ctl = rp.recCtl, src = rp.t;
  try {
    const out = await ctl.done;
    const at = Date.now();
    const rec = {
      id: String(at), name: `${src.name} (מחדש)`.slice(0, 60), base: `eliran-${stamp(new Date(at))}-replay`, at, ms: out.ms,
      kind: "replay", from: src.id, video: out.video.blob, videoType: out.video.type, perf: src.perf, dets: src.dets, audio: src.audio,
    };
    await storeTake(rec);
    stopReplay();
    openResult(rec);
  } catch (e) {
    console.error(e);
    say("ההקלטה נכשלה בדפדפן הזה.", true);
    if (rp) { rp.recCtl = null; updateReplayBar(); }
  } finally {
    ui.dot.hidden = true;
  }
}
function stopReplay() {
  if (!rp) return;
  if (rp.recCtl) { const c = rp.recCtl; rp.recCtl = null; c.stop(); }
  rp.src?.stop();
  rp = null;
  ui.rpBar.hidden = true;
  show(...shown);
}

// ---- editor ("ערוך": timeline on a take, offline render; editor.js) -------------------------------------------------
const editor = createEditor({
  stage,
  getAudio: () => (actx ??= new AudioContext()),
  putTake, storeTake, openResult, say,
  onClose: () => { if (media) keepAwake(); },
});
function openEditor(t) {
  if (!stage.vrm || liveRec) return;
  stopReplay();
  editor.open(t);
}

// ---- the loop -----------------------------------------------------------------------------------------------
let prev = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (editor.rendering) { requestAnimationFrame(loop); return; } // the offline render owns the stage
  if (editor.active) {
    editor.tick();
  } else if (rp) {
    // Replay: the file drives the rig; the camera is not read.
    rp.tv = rp.p0 == null ? -1e9 : now - rp.p0;
    rp.replay?.feed(rp.tv);
    if (rp.replay && rp.tv > rp.replay.durationMs) replayEnded();
    rp.rig.apply(dt, rp.tv);
  } else {
    if (tracker && rig) {
      const r = tracker.detect(ui.cam);
      if (r) {
        stats.dets++; stats.detMs += r.ms; stats.face = !!r.face;
        if (r.face) window.__rec.shapes = r.face.shapes;
        rig.update(r.face, now);
        if (take) { take.det(now, r.face); if (r.face) trace("live", rig, now - take.t0); }
      }
    }
    rig?.apply(dt, now);
  }
  stage.render(dt);
  frameDrawn();
  take?.frame(now);
  stats.frames++;
  if (now - stats.t >= 1000) {
    const sec = (now - stats.t) / 1000, fps = stats.frames / sec, tps = stats.dets / sec;
    const ms = stats.dets ? stats.detMs / stats.dets : 0;
    const cls = (v) => (v >= 24 ? "" : v >= 15 ? "warn" : "bad");
    ui.fps.innerHTML = `<span class="${cls(fps)}">render <b>${fps.toFixed(0)}</b></span> · ` +
      (editor.active ? "editor" : rp ? "replay" : tracker ? `<span class="${cls(tps)}">face <b>${tps.toFixed(0)}</b></span> · ${ms.toFixed(0)}ms ${tracker.delegate}` +
        (stats.face ? "" : ` · <span class="warn">no face</span>`) : "tracking off");
    window.__rec.fps = { render: fps, face: tps, ms };
    stats.frames = stats.dets = stats.detMs = 0; stats.t = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.__recBooted = true; // index.html boot guard

// ---- boot ---------------------------------------------------------------------------------------------------
(async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    say("הדף צריך לרוץ ב-https כדי לגשת למצלמה.", true);
  }
  if (pickType() === null) ui.hint.textContent = "הדפדפן הזה לא יודע להקליט וידאו.";
  // WhatsApp / Instagram / Facebook / Gmail open links in their own WebView, which usually blocks the camera.
  if (/; wv\)|FBAN|FBAV|Instagram|WhatsApp|Line\//.test(navigator.userAgent)) {
    say("הדף נפתח בתוך אפליקציה, ושם המצלמה בדרך כלל חסומה. לפתוח ב-Chrome: בתפריט ⋮ לבחור \"פתיחה ב-Chrome\" (או להעתיק את הקישור ל-Chrome).", true);
    window.__rec.inApp = true;
    return;
  }
  let saved = null;
  try { saved = await readModel(); } catch (e) {
    console.warn(e);
    if (e?.message === "blocked") {
      say("הדף פתוח גם בלשונית אחרת עם גרסה ישנה. לסגור את הלשוניות האחרות של הדף ולרענן.", true);
      return;
    }
  }
  if (saved?.blob) await loadModel(saved.blob, saved.name);
  else { say("בפעם הראשונה: בוחרים את קובץ ה-VRM של אלירן. הוא נשאר רק בטלפון ולא עולה לשום מקום."); showMain(ui.pick); }
})();
