// The recording page flow (docs/phone_recording.md): pick VRM (once, kept in IndexedDB) -> camera + mic ->
// live tracking -> record 10 s -> play back, share, save. Text in Hebrew; values from files are set with textContent.
import { createStage } from "./avatar.js";
import { createTracker } from "./tracking.js";
import { FaceRig } from "./mapping.js";
import { record, pickType } from "./recorder.js";

const SECONDS = 10;
const $ = (id) => document.getElementById(id);
const ui = {
  view: $("view"), cam: $("cam"), status: $("status"), fps: $("fps"), dot: $("rec-dot"), hint: $("hint"),
  pick: $("pick"), input: $("pick-input"), start: $("start"), record: $("record"), chips: $("chips"),
  mirror: $("t-mirror"), showCam: $("t-cam"), frame: $("t-frame"), calib: $("calib"), swap: $("swap"),
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
ui.start.onclick = async () => {
  if (busy) return;
  busy = true;
  ui.start.disabled = true;
  try {
    say("מבקש גישה למצלמה ולמיקרופון…");
    media = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: true,
    });
    ui.cam.srcObject = media;
    await ui.cam.play();
    say("טוען מעקב פנים… (בפעם הראשונה כמה שניות)");
    tracker = await createTracker();
    say("");
    show(ui.record);
    keepAwake();
  } catch (e) {
    console.error(e);
    media?.getTracks().forEach((t) => t.stop());
    media = null;
    const denied = e?.name === "NotAllowedError";
    say(denied ? "אין הרשאה למצלמה או למיקרופון. אפשר להפעיל בהגדרות האתר בדפדפן ולנסות שוב."
               : "לא הצלחתי להפעיל את המצלמה או את מעקב הפנים.", true);
  } finally {
    busy = false;
    ui.start.disabled = false;
  }
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
    ui.record.textContent = `● הקלט ${SECONDS} שניות`;
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
  let saved = null;
  try { saved = await readModel(); } catch (e) { console.warn(e); }
  if (saved?.blob) await loadModel(saved.blob, saved.name);
  else { say("בפעם הראשונה: בוחרים את קובץ ה-VRM של אלירן. הוא נשאר רק בטלפון ולא עולה לשום מקום."); show(ui.pick); }
})();
