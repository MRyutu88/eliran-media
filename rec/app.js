// The recording page flow (docs/phone_recording.md): pick VRM (once, kept in IndexedDB) -> camera + mic ->
// live tracking -> record 10 s -> play back, share, save. Text in Hebrew; values from files are set with textContent.
import { createStage } from "./avatar.js";
import { createTracker } from "./tracking.js";
import { FaceRig } from "./mapping.js";
import { record, pickType, frameDrawn } from "./recorder.js";

const SECONDS = 10;
const $ = (id) => document.getElementById(id);
const ui = {
  view: $("view"), cam: $("cam"), status: $("status"), fps: $("fps"), dot: $("rec-dot"), hint: $("hint"),
  pick: $("pick"), input: $("pick-input"), start: $("start"), record: $("record"), chips: $("chips"),
  micRetry: $("mic-retry"), mirror: $("t-mirror"), showCam: $("t-cam"), frame: $("t-frame"), calib: $("calib"), swap: $("swap"),
  result: $("result"), playback: $("playback"), meta: $("meta"), share: $("share"), save: $("save"), again: $("again"),
};

function say(text, bad = false) {
  ui.status.hidden = !text;
  ui.status.textContent = text || "";
  ui.status.classList.toggle("bad", bad);
}
function show(...els) { for (const el of [ui.pick, ui.start, ui.record]) el.hidden = !els.includes(el); }

// ---- the model file, kept on this phone only -------------------------------------------------------------
const DB = "eliran-rec", STORE = "files";
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveModel = (file) => idb("readwrite", (s) => s.put({ blob: file, name: file.name, at: Date.now() }, "vrm"));
const readModel = () => idb("readonly", (s) => s.get("vrm"));

// ---- state ------------------------------------------------------------------------------------------------
const stage = createStage(ui.view);
let rig = null, tracker = null, media = null, wake = null, busy = false, lastUrl = null, lastFile = null;
const stats = { frames: 0, dets: 0, detMs: 0, t: performance.now(), face: false };
window.__rec = { stage, get rig() { return rig; }, get tracker() { return tracker; }, stats }; // for local tests

async function loadModel(blob, name) {
  say("טוען את אלירן…");
  try {
    const buf = await blob.arrayBuffer();
    const vrm = await stage.load(buf);
    const mirror = rig ? rig.mirror : true;
    rig = new FaceRig(vrm);
    rig.mirror = mirror;
    ui.chips.hidden = false;
    if (media) { show(ui.record); say(""); } else { show(ui.start); say(""); }
    ui.hint.hidden = false;
    ui.hint.textContent = `מודל: ${name || "VRM"} · ${(blob.size / 1e6).toFixed(1)}MB · ${rig.driven.length} הבעות מחוברות`;
    return true;
  } catch (e) {
    console.error(e);
    say(e.message === "not-vrm" ? "הקובץ הזה לא VRM. צריך קובץ ‎.vrm‎ של אלירן." : "לא הצלחתי לטעון את המודל.", true);
    show(ui.pick);
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
  ui.record.textContent = `● הקלט ${SECONDS} שניות${micError ? " (בלי קול)" : ""}`;
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
    show(ui.record);
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
function toggle(btn, on) { btn.setAttribute("aria-pressed", String(on)); return on; }
ui.mirror.onclick = () => { if (rig) rig.mirror = toggle(ui.mirror, !rig.mirror); };
ui.showCam.onclick = () => { ui.cam.hidden = !toggle(ui.showCam, ui.cam.hidden); };
ui.frame.onclick = () => stage.frame(toggle(ui.frame, stage.framing !== "close") ? "close" : "body");
ui.calib.onclick = () => {
  if (!rig?.raw) { say("לא רואה פנים כרגע. הסתכל ישר למצלמה עם פנים רגילות ונסה שוב.", true); setTimeout(() => say(""), 2500); return; }
  rig.calibrate();
  say("כויל ✓ הפנים האלה הן עכשיו \"רגיל\""); setTimeout(() => say(""), 1500);
};

// ---- record -------------------------------------------------------------------------------------------------
ui.record.onclick = async () => {
  if (busy || !media) return;
  busy = true;
  ui.record.disabled = true;
  ui.record.classList.add("rec");
  ui.dot.hidden = false;
  try {
    const out = await record(ui.view, media.getAudioTracks()[0], SECONDS, (left) => {
      ui.dot.textContent = `● ${left}`;
      ui.record.textContent = `מקליט… ${left}`;
    });
    openResult(out);
  } catch (e) {
    console.error(e);
    say("ההקלטה נכשלה בדפדפן הזה.", true);
  } finally {
    busy = false;
    ui.dot.hidden = true;
    ui.record.disabled = false;
    ui.record.classList.remove("rec");
    showMicState();
  }
};

function openResult({ blob, type, ms }) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const ext = type.includes("mp4") ? "mp4" : "webm";
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const name = `eliran-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  lastFile = new File([blob], name, { type: type.split(";")[0] });
  ui.playback.src = lastUrl;
  ui.save.href = lastUrl;
  ui.save.download = name;
  ui.meta.textContent = `${name} · ${(blob.size / 1e6).toFixed(1)}MB · ${(ms / 1000).toFixed(1)} שניות · ${type}`;
  ui.share.hidden = !(navigator.canShare && navigator.canShare({ files: [lastFile] }));
  ui.result.hidden = false;
  ui.playback.play().catch(() => {});
  window.__rec.last = { size: blob.size, type, ms, name };
}

ui.share.onclick = () => {
  if (!lastFile) return;
  navigator.share({ files: [lastFile], title: "אלירן" }).catch((e) => {
    if (e?.name !== "AbortError") say("השיתוף לא נפתח. אפשר \"שמור\" ולשתף מהגלריה.", true);
  });
};
ui.again.onclick = () => { ui.playback.pause(); ui.result.hidden = true; };

// ---- the loop -----------------------------------------------------------------------------------------------
let prev = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (tracker && rig) {
    const r = tracker.detect(ui.cam);
    if (r) {
      stats.dets++; stats.detMs += r.ms; stats.face = !!r.face;
      if (r.face) window.__rec.shapes = r.face.shapes;
      rig.update(r.face, now);
    }
  }
  rig?.apply(dt, now);
  stage.render(dt);
  frameDrawn();
  stats.frames++;
  if (now - stats.t >= 1000) {
    const sec = (now - stats.t) / 1000, fps = stats.frames / sec, tps = stats.dets / sec;
    const ms = stats.dets ? stats.detMs / stats.dets : 0;
    const cls = (v) => (v >= 24 ? "" : v >= 15 ? "warn" : "bad");
    ui.fps.innerHTML = `<span class="${cls(fps)}">render <b>${fps.toFixed(0)}</b></span> · ` +
      (tracker ? `<span class="${cls(tps)}">face <b>${tps.toFixed(0)}</b></span> · ${ms.toFixed(0)}ms ${tracker.delegate}` +
        (stats.face ? "" : ` · <span class="warn">no face</span>`) : "tracking off");
    window.__rec.fps = { render: fps, face: tps, ms };
    stats.frames = stats.dets = stats.detMs = 0; stats.t = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

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
  try { saved = await readModel(); } catch (e) { console.warn(e); }
  if (saved?.blob) await loadModel(saved.blob, saved.name);
  else { say("בפעם הראשונה: בוחרים את קובץ ה-VRM של אלירן. הוא נשאר רק בטלפון ולא עולה לשום מקום."); show(ui.pick); }
})();
