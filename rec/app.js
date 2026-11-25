// The recording page flow (docs/phone_recording.md): pick VRM (once, kept in IndexedDB) -> camera + mic ->
// live tracking -> record a take (start/stop, up to MAX_MS) = the video + a performance file (take.js) -> takes list
// (play, share, save, delete) -> "נגן מחדש" drives Eliran from the file, and can record that to a new video ->
// "ערוך" opens the timeline editor on the take (editor.js), which renders the edit offline to an MP4 (render.js).
// Text in Hebrew; values from files are set with textContent.
import { createStage } from "./avatar.js?v=7";
import { createTracker } from "./tracking.js?v=7";
import { FaceRig } from "./mapping.js?v=7";
import { startRecording, pickType, frameDrawn } from "./recorder.js?v=7";
import { TakeWriter, readTake, createReplay, EXT } from "./take.js?v=7";
import { createEditor } from "./editor.js?v=7";
import { mediaIds } from "./layers.js?v=7";
import { BodyRig, GROUPS, DEFAULTS, loadSettings, saveSettings, loadPresets, savePresets, checkPresets, checkSettings, sameSettings, PRESET_FILE } from "./body.js?v=7";
import { VOICE_PRESETS, VOICE_DEFAULTS, checkVoice, loadVoice, saveVoice, applyPreset, presetOf, processVoice, createLiveVoice, workletSupported } from "./voice.js?v=7";

// Must match <meta name="rec-version"> in index.html. A different value = the phone mixed cached files from two
// versions: reload once with a fresh URL (index.html then comes fresh and asks for matching files).
const REC_VERSION = "7";
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
  calib: $("calib"), swap: $("swap"), takesBtn: $("takes-btn"), setBtn: $("set-btn"),
  set: $("settings"), setList: $("set-list"), setClose: $("set-close"), setReset: $("set-reset"),
  tabBody: $("tab-body"), tabVoice: $("tab-voice"), presetInput: $("preset-input"), resultNote: $("result-note"),
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
// Images for the editor (layers.js), version 7: in the same "files" store under "media:<id>" (no database upgrade):
// {id, blob, name, type, w, h, at}. They stay while any take's edit uses them (gcMedia after a delete / editor close).
const putMedia = (m) => idb("readwrite", (s) => s.put(m, "media:" + m.id));
const getMedia = (id) => idb("readonly", (s) => s.get("media:" + id));
async function gcMedia() {
  try {
    const used = new Set();
    for (const t of await allTakes()) for (const id of mediaIds(t.edit)) used.add(id);
    const keys = (await idb("readonly", (s) => s.getAllKeys())) || [];
    const drop = keys.filter((k) => typeof k === "string" && k.startsWith("media:") && !used.has(k.slice(6)));
    if (drop.length) await idb("readwrite", (s) => { for (const k of drop) s.delete(k); });
    window.__rec.mediaGc = { kept: used.size, dropped: drop.length };
  } catch (e) { console.warn("media gc", e); }
}

// ---- state ------------------------------------------------------------------------------------------------
const stage = createStage(ui.view);
let rig = null, tracker = null, media = null, wake = null, busy = false, lastUrl = null, current = null, modelInfo = null;
let take = null, liveRec = null; // the take being recorded: TakeWriter + recorder controller
let rp = null;                   // replay state (startReplay)
let body = null;                 // BodyRig (body.js) on the loaded model, for live and replay
const bodySettings = loadSettings(); // "⚙ הגדרות"; changed in place, so every rig that holds it sees changes at once
const voiceSettings = loadVoice();   // "⚙ הגדרות" -> "🎤 קול" (voice.js); also changed in place
let presets = loadPresets();         // motion presets (body.js)
let liveVoice = null;                // the live mic chain (voice.js createLiveVoice): its track goes into the video
let monitorOn = false;               // "🎧 לשמוע בזמן אמת"
const stats = { frames: 0, dets: 0, detMs: 0, t: performance.now(), face: false };
// For local tests. __rec.trace = [] collects {src, t, target, head} after every face update (live while recording,
// and in replay), to compare the two.
window.__rec = { stage, get body() { return body; }, bodySettings, voiceSettings, get presets() { return presets; }, get liveVoice() { return liveVoice; }, get rig() { return rig; }, get tracker() { return tracker; }, get replay() { return rp; }, stats, trace: null };
const trace = (src, r, t) => window.__rec.trace?.push({ src, t, target: { ...r.target }, head: { ...r.head } });

async function loadModel(blob, name) {
  say("טוען את אלירן…");
  try {
    const buf = await blob.arrayBuffer();
    const vrm = await stage.load(buf);
    const mirror = rig ? rig.mirror : true;
    rig = new FaceRig(vrm);
    rig.mirror = mirror;
    body = new BodyRig(vrm, stage, bodySettings);
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
// The mic without echo cancellation and auto gain (both colour the voice; the level is set in voice.js), noise
// suppression as set in "🎤 קול". Then the live chain (voice changer + clean-up) for the recorded video.
const micTrack = () => media?.getAudioTracks()[0] ?? null;
async function openMic() {
  for (const t of media.getAudioTracks()) { t.stop(); media.removeTrack(t); }
  liveVoice?.close(); liveVoice = null;
  try {
    const a = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: false, autoGainControl: false, noiseSuppression: voiceSettings.clean, channelCount: 1 } });
    for (const t of a.getAudioTracks()) media.addTrack(t);
    micError = null;
  } catch (e) {
    console.warn("mic", e);
    micError = e;
  }
  if (micTrack()) {
    try {
      actx ??= new AudioContext();
      await actx.resume();
      liveVoice = await createLiveVoice(actx, micTrack(), voiceSettings);
      liveVoice.monitor(monitorOn);
    } catch (e) { console.warn("live voice chain", e); liveVoice = null; }
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
  take?.event("calib", { offset: { ...rig.offset }, base: { ...rig.base }, offsetPos: rig.offsetPos && { ...rig.offsetPos } });
  say("כויל ✓ הפנים האלה הן עכשיו \"רגיל\""); setTimeout(() => say(""), 1500);
};

// ---- record a take ------------------------------------------------------------------------------------------
// Start/stop (stops by itself at MAX_MS). Each take = the regular video + a performance file, kept in IndexedDB.
function takeInfo() {
  return {
    settings: { mirror: rig.mirror, framing: stage.framing, calibration: { offset: { ...rig.offset }, base: { ...rig.base }, offsetPos: rig.offsetPos && { ...rig.offsetPos } } },
    body: JSON.parse(JSON.stringify(bodySettings)),
    voice: { ...JSON.parse(JSON.stringify(voiceSettings)), live: !!liveVoice?.fx },
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
  for (const b of [ui.swap, ui.takesBtn, ui.micRetry]) b.disabled = on; // "⚙ הגדרות" stays open: it is the look, not the take
}

ui.record.onclick = async () => {
  if (liveRec) { liveRec.stop(); return; }
  if (busy || !media || !rig) return;
  let ctl;
  try {
    // the video gets the processed voice; the performance file the raw mic (so the voice can be changed later)
    ctl = startRecording(ui.view, liveVoice?.track ?? micTrack(), {
      maxMs: MAX_MS, separateAudio: true, rawTrack: micTrack(),
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
  ui.resultNote.textContent = t.kind === "render"
    ? "✓ הסרטון הערוך נשמר ב-🎞 הקלטות. הטיוטה נשארת: אפשר לחזור לערוך ולרנדר שוב."
    : "✓ ההקלטה נשמרה ב-🎞 הקלטות (הגולמי, עם קובץ הביצוע). אפשר לערוך עכשיו או לחזור אליה אחר כך, ולרנדר רק כשמוכנים.";
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
// A draft = a take with an edit that was not rendered since its last change (editor.js sets `exported` on render).
const isDraft = (t) => t.kind !== "render" && !!t.edit && !(t.exported >= (t.edit.updated || 0));
async function countDrafts() {
  let n = 0;
  try { n = (await allTakes()).filter(isDraft).length; } catch { /* label only */ }
  ui.takesBtn.textContent = n ? `🎞 הקלטות (📝 ${n})` : "🎞 הקלטות";
  return n;
}
async function renderTakes() {
  let list = [];
  try { list = await allTakes(); } catch (e) { console.error(e); }
  ui.takesList.replaceChildren();
  const drafts = list.filter(isDraft).sort((a, b) => (b.edit.updated || 0) - (a.edit.updated || 0)), rest = list.filter((t) => !isDraft(t));
  ui.takesNote.textContent = list.length ? `${list.length} הקלטות, שמורות רק בדפדפן הזה בטלפון.${drafts.length ? ` ${drafts.length} טיוטות שעוד לא רונדרו.` : ""}` : "אין עדיין הקלטות.";
  const heading = (text) => { const h = document.createElement("h2"); h.textContent = text; ui.takesList.append(h); };
  if (drafts.length) heading("📝 טיוטות (עריכה שעוד לא יצאה לווידאו)");
  drafts.forEach((t) => takeItem(t, true));
  if (drafts.length && rest.length) heading("כל ההקלטות");
  rest.forEach((t) => takeItem(t, false));
  countDrafts();
}
function takeItem(t, draft) {
  {
    const li = document.createElement("li"), head = document.createElement("div"), name = document.createElement("b");
    const meta = document.createElement("span"), row = document.createElement("div");
    name.textContent = t.name;
    if (draft || (t.edit && t.kind !== "render")) {
      const b = document.createElement("span"); b.className = "badge" + (draft ? "" : " done");
      b.textContent = draft ? "📝 טיוטה" : "✓ יצא לווידאו";
      name.append(b);
    }
    if (draft) li.className = "draft";
    meta.textContent = isolate([niceDate(t.at), fmt(t.ms), t.audio ? "" : "בלי קול",
      t.kind === "render" && t.render ? `ערוך ${t.render.h}p${t.render.fps}` : draft ? `נערך ${niceDate(t.edit.updated || t.at)}` : ""]);
    head.append(name, meta);
    row.className = "chips";
    row.append(
      btn("▶ צפה", () => { ui.takes.hidden = true; openResult(t); }),
      btn(draft ? "✂ המשך לערוך" : t.edit && t.kind !== "render" ? "✂ ערוך שוב" : "✂ ערוך", () => { ui.takes.hidden = true; openEditor(t); }),
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
        await delTake(t.id); renderTakes(); gcMedia();
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
      rp.buffer = await processVoice(await actx.decodeAudioData(await data.audio.arrayBuffer()), voiceSettings);
      rp.dest = actx.createMediaStreamDestination();
    } catch (e) { console.warn("replay audio", e); rp.buffer = null; }
  }
  window.__rec.replayHeader = data.header;
  body?.reset();
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
  putTake, storeTake, openResult, say, bodySettings, voiceSettings, openSettings,
  media: { put: putMedia, get: getMedia },
  onClose: (saved) => {
    gcMedia();
    if (media) keepAwake();
    countDrafts();
    if (saved) { say("📝 הטיוטה נשמרה. חוזרים אליה מ-🎞 הקלטות, ומרנדרים כשמוכנים."); setTimeout(() => say(""), 3500); }
  },
});
// ---- settings ("⚙ הגדרות"): two tabs. "🕺 תנועה" = motion presets + the body extras (body.js); "🎤 קול" = voice.js ----
// A bottom sheet, so Eliran stays visible above it while tuning. Every change applies at once (live, replay, editor)
// and is kept in localStorage. Not take events: replay/editor/render always use the current settings.
let setTimer = null, setTab = "body";
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function section(title, hint) {
  const box = mk("section"), top = mk("div", "set-top");
  top.append(mk("b", "", title));
  box.append(top);
  if (hint) box.append(mk("p", "", hint));
  return box;
}
function slider(box, label, min, max, step, value, onInput, show) {
  const row = mk("label", "set-row"), input = mk("input"), val = mk("output");
  Object.assign(input, { type: "range", min, max, step, value });
  const paint = () => { val.textContent = show(Number(input.value)); };
  input.oninput = () => { onInput(Number(input.value)); paint(); };
  paint();
  row.append(mk("span", "", label), input, val);
  box.append(row);
  return input;
}
function settingsChanged() {
  saveSettings(bodySettings);
  clearTimeout(setTimer);
  setTimer = setTimeout(() => editor.bodyChanged(), 150); // the editor recomputes its body track
  paintPresets();
}

// -- motion presets (body.js loadPresets/savePresets): tap = apply; the active one shows "•" once changed ----------
let presetBox = null;
function paintPresets() { if (presetBox?.isConnected) fillPresets(presetBox); }
function storePresets() {
  if (!savePresets(presets)) say("לא הצלחתי לשמור את הפריסטים בדפדפן.", true);
  paintPresets();
}
function fillPresets(box) {
  box.replaceChildren();
  const top = mk("div", "set-top");
  top.append(mk("b", "", "💾 פריסטים"));
  box.append(top);
  const cur = presets.list.find((p) => p.name === presets.active);
  const dirty = !!cur && !sameSettings(cur.body, bodySettings);
  box.append(mk("p", "", !presets.list.length ? "שומרים את ההגדרות של עכשיו בשם, וחוזרים אליהן בלחיצה."
    : cur ? (dirty ? `שינית מאז "${cur.name}". "עדכן" שומר את השינויים בתוכו, או לחיצה על פריסט מחזירה אותו.` : `פעיל: "${cur.name}" ✓`)
    : "לחיצה על פריסט מחזירה את ההגדרות שלו."));
  if (presets.list.length) {
    const row = mk("div", "chips");
    for (const p of presets.list) {
      const b = btn(p.name, () => applyBodyPreset(p.name), p.name === presets.active && dirty ? "dirty" : "");
      b.setAttribute("aria-pressed", String(p.name === presets.active));
      row.append(b);
    }
    box.append(row);
  }
  const act = mk("div", "chips");
  act.append(btn("+ שמור כפריסט חדש", savePresetNew));
  if (cur) {
    const up = btn(`⟳ עדכן את "${cur.name}"`, () => { cur.body = checkSettings(bodySettings); cur.at = Date.now(); storePresets(); say("הפריסט עודכן ✓"); setTimeout(() => say(""), 1500); });
    up.disabled = !dirty;
    act.append(up,
      btn("✎ שם", () => {
        const n = prompt("שם חדש לפריסט:", cur.name)?.trim().slice(0, 40);
        if (!n || n === cur.name) return;
        if (presets.list.some((p) => p.name === n)) { alert(`כבר יש פריסט בשם "${n}".`); return; }
        cur.name = n; presets.active = n; storePresets();
      }),
      btn("🗑 מחק", () => {
        if (!confirm(`למחוק את הפריסט "${cur.name}"? ההגדרות של עכשיו לא משתנות.`)) return;
        presets.list = presets.list.filter((p) => p !== cur); presets.active = null; storePresets();
      }, "danger"));
  }
  act.append(btn("⇩ גיבוי לקובץ", exportPresets), btn("⇧ טען מקובץ", () => ui.presetInput.click()));
  box.append(act);
}
function applyBodyPreset(name) {
  const p = presets.list.find((x) => x.name === name);
  if (!p) return;
  const d = checkSettings(p.body);
  for (const k of Object.keys(d)) bodySettings[k] = d[k];
  presets.active = name;
  savePresets(presets);
  settingsChanged();
  buildSettings();
}
function savePresetNew() {
  const name = prompt("שם לפריסט:", `פריסט ${presets.list.length + 1}`)?.trim().slice(0, 40);
  if (!name) return;
  const i = presets.list.findIndex((x) => x.name === name);
  if (i >= 0 && !confirm(`כבר יש פריסט בשם "${name}". להחליף אותו בהגדרות של עכשיו?`)) return;
  const entry = { name, at: Date.now(), body: checkSettings(bodySettings) };
  if (i >= 0) presets.list[i] = entry; else presets.list.push(entry);
  presets.active = name;
  storePresets();
  say(`נשמר: "${name}" ✓`); setTimeout(() => say(""), 1500);
}
// The backup file: every motion preset + the current voice settings.
function exportPresets() {
  const file = { format: PRESET_FILE, version: 1, saved: new Date().toISOString(), active: presets.active, list: presets.list, voice: { ...voiceSettings } };
  download(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), `${PRESET_FILE}-${stamp()}.json`);
}
ui.presetInput.onchange = async () => {
  const f = ui.presetInput.files?.[0];
  ui.presetInput.value = "";
  if (!f) return;
  let j;
  try { j = JSON.parse(await f.text()); } catch { j = null; }
  if (!j || j.format !== PRESET_FILE) { say("זה לא קובץ פריסטים של הדף הזה.", true); setTimeout(() => say(""), 3000); return; }
  if (j.version > 1) { say("הקובץ נשמר בגרסה חדשה יותר של הדף. לרענן את הדף.", true); return; }
  const inc = checkPresets(j);
  for (const p of inc.list) {
    const i = presets.list.findIndex((x) => x.name === p.name);
    if (i >= 0) presets.list[i] = p; else presets.list.push(p);
  }
  if (j.voice && confirm("בקובץ יש גם הגדרות קול. לטעון גם אותן?")) {
    const v = checkVoice(j.voice), clean = voiceSettings.clean;
    Object.assign(voiceSettings, v);
    voiceChanged();
    if (v.clean !== clean) reopenMic();
  }
  storePresets();
  buildSettings();
  say(`נטענו ${inc.list.length} פריסטים ✓`); setTimeout(() => say(""), 2000);
};

function buildBody(list) {
  presetBox = mk("section", "presets");
  fillPresets(presetBox);
  list.append(presetBox);
  for (const g of GROUPS) {
    const st = bodySettings[g.key], box = section(g.name, g.hint);
    const on = mk("button", "set-on");
    const paint = () => {
      on.setAttribute("aria-pressed", String(st.on)); on.textContent = st.on ? "פועל" : "כבוי";
      box.classList.toggle("off", !st.on);
    };
    on.onclick = () => { st.on = !st.on; paint(); settingsChanged(); };
    box.firstChild.append(on);
    for (const [key, label, min, max, stepV] of g.sliders) {
      const input = slider(box, label, min, max, stepV, st[key], (v) => { st[key] = v; settingsChanged(); }, (v) => `${Math.round(v * 100)}%`);
      input.dataset.key = `${g.key}.${key}`;
    }
    for (const [key, label] of g.switches || []) {
      const b = mk("button", "set-sw");
      const p2 = () => { b.setAttribute("aria-pressed", String(st[key])); b.textContent = (st[key] ? "✓ " : "") + label; };
      b.onclick = () => { st[key] = !st[key]; p2(); settingsChanged(); };
      p2();
      box.append(b);
    }
    paint();
    list.append(box);
  }
}

// -- voice ("🎤 קול", voice.js) ------------------------------------------------------------------------------------------
function voiceChanged() {
  voiceSettings.preset = presetOf(voiceSettings);
  saveVoice(voiceSettings);
  liveVoice?.update(voiceSettings);
  editor.voiceChanged(); // the editor processes the take's sound again
}
async function reopenMic() {
  if (!media || liveRec || busy) return;
  busy = true;
  await openMic();
  busy = false;
}
const semis = (v) => (v > 0 ? `+${v}` : `${v}`);
const vtest = { rec: null, raw: null, src: null, busy: false }; // "🎙 ניסיון": 5 s of raw mic, played with the voice
async function voiceTestPlay() {
  if (!vtest.raw || vtest.busy) return;
  vtest.busy = true;
  try {
    try { vtest.src?.stop(); } catch { /* ended */ }
    const buf = await processVoice(vtest.raw, voiceSettings);
    const s = actx.createBufferSource();
    s.buffer = buf; s.connect(actx.destination); s.start();
    vtest.src = s;
  } catch (e) { console.warn("voice test", e); say("לא הצלחתי להשמיע את הניסיון.", true); }
  vtest.busy = false;
}
function voiceTestRecord() {
  if (vtest.rec) { vtest.rec.stop(); return; }
  if (!micTrack()) { say("צריך קודם \"הפעל מצלמה ומיקרופון\" (ושהמיקרופון יעבוד).", true); setTimeout(() => say(""), 3000); return; }
  const stream = new MediaStream([micTrack().clone()]), chunks = [];
  const r = new MediaRecorder(stream);
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    vtest.rec = null;
    try {
      actx ??= new AudioContext(); await actx.resume();
      vtest.raw = await actx.decodeAudioData(await new Blob(chunks, { type: r.mimeType }).arrayBuffer());
      window.__rec.voiceTest = { secs: vtest.raw.duration };
    } catch (e) { console.warn("voice test decode", e); }
    if (setTab === "voice" && !ui.set.hidden) buildSettings();
    voiceTestPlay();
  };
  r.start();
  vtest.rec = r;
  setTimeout(() => { if (r.state !== "inactive") r.stop(); }, 5000);
  buildSettings();
}
function buildVoice(list) {
  const fx = workletSupported();
  const box = section("🎤 הקול בווידאו", fx
    ? "הקול משתנה בכל וידאו: בהקלטה, ב\"נגן מחדש\" וברנדר. קובץ הביצוע שומר את הקול המקורי, אז אפשר להחליף קול גם אחרי שהקלטת ולרנדר שוב."
    : "הדפדפן הזה לא יודע לשנות קול (אין AudioWorklet), אז הקול יוצא מקורי. לנסות ב-Chrome מעודכן.");
  const row = mk("div", "chips"), cur = presetOf(voiceSettings);
  for (const p of VOICE_PRESETS) {
    const b = btn(p.name, () => { applyPreset(voiceSettings, p.id); voiceChanged(); buildSettings(); });
    b.setAttribute("aria-pressed", String(cur === p.id));
    row.append(b);
  }
  if (cur === "custom") { const b = mk("button", "", "מותאם"); b.setAttribute("aria-pressed", "true"); b.disabled = true; row.append(b); }
  box.append(row);
  const knobs = mk("div");
  knobs.style.cssText = "display:flex;flex-direction:column;gap:4px";
  if (!voiceSettings.on) knobs.style.opacity = ".4";
  const turnOn = () => { if (!voiceSettings.on) { voiceSettings.on = true; knobs.style.opacity = ""; } };
  const mark = () => { const p = presetOf(voiceSettings); row.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(VOICE_PRESETS[i]?.id === p))); };
  slider(knobs, "גובה", -12, 12, 1, voiceSettings.pitch, (v) => { turnOn(); voiceSettings.pitch = v; voiceChanged(); mark(); }, semis).dataset.key = "voice.pitch";
  slider(knobs, "גוון", -6, 6, 1, voiceSettings.formant, (v) => { turnOn(); voiceSettings.formant = v; voiceChanged(); mark(); }, semis).dataset.key = "voice.formant";
  knobs.append(mk("p", "", "גובה = כמה גבוה הקול (חצאי טונים). גוון = \"גודל\" הגרון: למעלה קטן ומצויר, למטה גדול. שניהם יחד מרחיקים מהקול האמיתי."));
  const rb = mk("button", "set-sw");
  const paintRb = () => { rb.setAttribute("aria-pressed", String(voiceSettings.robot)); rb.textContent = (voiceSettings.robot ? "✓ " : "") + "🤖 רובוטי (טון אחד קבוע)"; };
  rb.onclick = () => { turnOn(); voiceSettings.robot = !voiceSettings.robot; voiceChanged(); buildSettings(); };
  paintRb();
  knobs.append(rb);
  if (voiceSettings.robot) slider(knobs, "טון", 60, 300, 5, voiceSettings.robotHz, (v) => { voiceSettings.robotHz = v; voiceChanged(); }, (v) => `${v}Hz`);
  box.append(knobs);
  list.append(box);

  const test = section("🎧 לשמוע איך זה נשמע", "מקליטים 5 שניות ושומעים אותן עם הקול שנבחר. אחרי שינוי בהגדרות, \"השמע שוב\".");
  const tr = mk("div", "chips");
  const recB = btn(vtest.rec ? "■ עצור" : "🎙 הקלט ניסיון (5 ש׳)", voiceTestRecord);
  recB.disabled = !!liveRec;
  const playB = btn("▶ השמע שוב", voiceTestPlay);
  playB.disabled = !vtest.raw;
  const monB = btn((monitorOn ? "✓ " : "") + "🎧 בזמן אמת", () => { monitorOn = !monitorOn; liveVoice?.monitor(monitorOn); buildSettings(); });
  monB.setAttribute("aria-pressed", String(monitorOn));
  monB.disabled = !liveVoice;
  tr.append(recB, playB, monB);
  test.append(tr, mk("p", "set-note", "\"בזמן אמת\" רק עם אוזניות: בלי אוזניות הרמקול נכנס חזרה למיקרופון."));
  list.append(test);

  const q = section("✨ איכות הסאונד", "בכל ייצוא הקול מנוקה ומאוזן: מסנן רעש נמוך (רעידות, מזגן), דחיסה עדינה, עוצמה אחידה וחזקה (כמו בפודקאסט) ובלי עיוותים בשיא.");
  const cl = mk("button", "set-sw");
  cl.setAttribute("aria-pressed", String(voiceSettings.clean));
  cl.textContent = (voiceSettings.clean ? "✓ " : "") + "ניקוי רעשי רקע במיקרופון";
  cl.onclick = async () => { voiceSettings.clean = !voiceSettings.clean; saveVoice(voiceSettings); buildSettings(); await reopenMic(); };
  cl.disabled = !!liveRec;
  q.append(cl, mk("p", "set-note", "כבוי = הקול הכי טבעי בחדר שקט. דולק = פחות רעש רקע ברחוב או ליד מאוורר."));
  list.append(q);
}

function buildSettings() {
  ui.setList.replaceChildren();
  ui.tabBody.setAttribute("aria-pressed", String(setTab === "body"));
  ui.tabVoice.setAttribute("aria-pressed", String(setTab === "voice"));
  if (setTab === "voice") buildVoice(ui.setList); else buildBody(ui.setList);
}
function openSettings(tab) { if (tab === "body" || tab === "voice") setTab = tab; buildSettings(); ui.set.hidden = false; }
ui.setBtn.onclick = () => openSettings();
ui.tabBody.onclick = () => { setTab = "body"; buildSettings(); };
ui.tabVoice.onclick = () => { setTab = "voice"; buildSettings(); };
ui.setClose.onclick = () => { ui.set.hidden = true; };
ui.setReset.onclick = () => {
  if (setTab === "voice") {
    const clean = voiceSettings.clean;
    Object.assign(voiceSettings, JSON.parse(JSON.stringify(VOICE_DEFAULTS)), { clean });
    voiceChanged();
  } else {
    const d = JSON.parse(JSON.stringify(DEFAULTS));
    for (const k of Object.keys(d)) bodySettings[k] = d[k];
    settingsChanged();
  }
  buildSettings();
};

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
    if (body) { body.update(BodyRig.input(rp.rig), rp.tv); body.write(); }
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
    if (rig && body) { body.update(BodyRig.input(rig), now); body.write(); }
  }
  stage.render(dt);
  if (editor.active) editor.drawn(); // the 2D layers (background, images) around Eliran
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
  countDrafts();
  if (saved?.blob) await loadModel(saved.blob, saved.name);
  else { say("בפעם הראשונה: בוחרים את קובץ ה-VRM של אלירן. הוא נשאר רק בטלפון ולא עולה לשום מקום."); showMain(ui.pick); }
})();
