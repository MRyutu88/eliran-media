// Voice: the voice changer and the sound clean-up (docs/phone_recording.md, "Voice and sound").
// - Settings ("⚙ הגדרות" -> "🎤 קול", localStorage eliran-rec-voice): a preset or own values: pitch and formant
//   (semitones), robot. On by default: the user does not want his real voice in the videos (25.11).
// - Live: mic -> high-pass -> voice-worklet.js (with a slow auto level) -> compressor -> limiter -> the recorded video's
//   audio track. The performance file keeps the raw mic, so the voice can be changed later and every take re-rendered.
// - Offline (replay, editor, render, the voice test): processVoice() = the same worklet in an OfflineAudioContext, the
//   delay taken out exactly, then clean-up in JS: high-pass, gentle compression, loudness to about -14 dB RMS on the
//   speech (about -16 LUFS), a look-ahead peak limiter at -1 dBFS. Deterministic: the same take gives the same sound.
// The mic is opened without echo cancellation and without auto gain (both colour the voice; the level is set here),
// noise suppression is a setting ("ניקוי רעשי רקע").

const KEY = "eliran-rec-voice";
export const VOICE_PRESETS = [
  { id: "off", name: "הקול שלי", on: false, pitch: 0, formant: 0, robot: false },
  { id: "eliran", name: "אלירן", on: true, pitch: 4, formant: 3, robot: false },
  { id: "chip", name: "צ'יפמאנק", on: true, pitch: 8, formant: 5, robot: false },
  { id: "kid", name: "ילד", on: true, pitch: 6, formant: 2, robot: false },
  { id: "deep", name: "עמוק", on: true, pitch: -4, formant: -3, robot: false },
  { id: "giant", name: "ענק", on: true, pitch: -9, formant: -5, robot: false },
  { id: "robot", name: "רובוט", on: true, pitch: 0, formant: 1, robot: true },
];
export const VOICE_DEFAULTS = { version: 1, preset: "eliran", on: true, pitch: 4, formant: 3, robot: false, robotHz: 120, clean: true };
const clone = (o) => JSON.parse(JSON.stringify(o));
export function checkVoice(s) {
  const out = clone(VOICE_DEFAULTS);
  if (!s || typeof s !== "object") return out;
  for (const [k, v] of Object.entries(VOICE_DEFAULTS)) if (typeof s[k] === typeof v && (typeof v !== "number" || isFinite(s[k]))) out[k] = s[k];
  out.pitch = Math.max(-12, Math.min(12, out.pitch));
  out.formant = Math.max(-6, Math.min(6, out.formant));
  out.robotHz = Math.max(60, Math.min(300, out.robotHz));
  return out;
}
export function loadVoice() { try { return checkVoice(JSON.parse(localStorage.getItem(KEY))); } catch { return clone(VOICE_DEFAULTS); } }
export function saveVoice(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }
export function applyPreset(s, id) {
  const p = VOICE_PRESETS.find((x) => x.id === id);
  if (!p) return;
  Object.assign(s, { preset: id, on: p.on, pitch: p.pitch, formant: p.formant, robot: p.robot });
}
// The preset the values match, or "custom".
export function presetOf(s) {
  const p = VOICE_PRESETS.find((x) => x.on === s.on && (!x.on || (x.pitch === s.pitch && x.formant === s.formant && x.robot === s.robot)));
  return p ? p.id : "custom";
}
export const voiceKey = (s) => JSON.stringify([s.on, s.pitch, s.formant, s.robot, s.robotHz]);

// The worklet's delay in samples for these settings (it needs to see half a grain past each grain's centre).
// Must stay the bound the worklet relies on (voice-worklet.js grain(): half = max(T/F, spacing)).
export function latencyFor(s, sr) {
  if (!s.on) return 0;
  const F = 2 ** (s.formant / 12), P = 2 ** (s.pitch / 12), Tmax = Math.ceil(sr / 4 / 75) * 4 + 8;
  const spacing = s.robot ? sr / s.robotHz : Tmax / P;
  const half = Math.max(Tmax / F, spacing, sr / 200, 16);
  return Math.ceil(half * (1 + F)) + 128;
}
const params = (s, sr, agc = false) => ({ on: s.on, pitch: s.pitch, formant: s.formant, robot: s.robot, robotHz: s.robotHz, D: latencyFor(s, sr), agc });

const loaded = new WeakSet();
async function ensureWorklet(ac) {
  if (loaded.has(ac)) return;
  if (!ac.audioWorklet) throw new Error("no-worklet");
  await ac.audioWorklet.addModule(new URL("./voice-worklet.js?v=6", import.meta.url));
  loaded.add(ac);
}
export const workletSupported = () => typeof AudioWorkletNode !== "undefined";

// ---- offline: a decoded take -> the sound that goes into replay / the editor / the render ------------------------
// buf = AudioBuffer of the raw mic. -> mono AudioBuffer, same length and rate, the voice delay removed.
export async function processVoice(buf, s) {
  const sr = buf.sampleRate, useFx = s.on && workletSupported();
  const D = useFx ? latencyFor(s, sr) : 0;
  const oc = new OfflineAudioContext(1, buf.length + D, sr);
  const src = oc.createBufferSource();
  src.buffer = buf;
  const hp = oc.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 80; hp.Q.value = 0.707;
  src.connect(hp);
  let last = hp;
  if (useFx) {
    await ensureWorklet(oc);
    const w = new AudioWorkletNode(oc, "eliran-voice", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit", processorOptions: { settings: params(s, sr) } });
    hp.connect(w); last = w;
  }
  last.connect(oc.destination);
  src.start(0);
  const rendered = await oc.startRendering();
  const x = rendered.getChannelData(0).slice(D, D + buf.length);
  polish(x, sr);
  const out = new AudioBuffer({ length: buf.length, numberOfChannels: 1, sampleRate: sr });
  out.copyToChannel(x, 0);
  return out;
}

// Clean-up in place: gentle compression, loudness of the speech to TARGET, look-ahead limiter at CEIL.
const TARGET = 10 ** (-14 / 20), CEIL = 10 ** (-1 / 20); // about -16 LUFS on speech
export function polish(x, sr) {
  const n = x.length;
  if (!n) return;
  // 1. compressor: 3:1 above -24 dB, 5 ms attack / 150 ms release on the peak envelope
  const thr = -24, ratio = 3, aA = 1 - Math.exp(-1 / (0.005 * sr)), aR = 1 - Math.exp(-1 / (0.15 * sr));
  let env = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    env += (a > env ? aA : aR) * (a - env);
    const db = 20 * Math.log10(env + 1e-9);
    if (db > thr) x[i] *= 10 ** ((thr - db) * (1 - 1 / ratio) / 20);
  }
  // 2. loudness: RMS of 50 ms windows; the speech = windows within 25 dB of the loudest and above -55 dBFS
  const win = Math.round(0.05 * sr), rms = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let k = i; k < i + win; k++) s += x[k] * x[k]; rms.push(Math.sqrt(s / win)); }
  const top = Math.max(0, ...rms), gate = Math.max(top * 10 ** (-25 / 20), 10 ** (-55 / 20));
  const speech = rms.filter((r) => r >= gate);
  if (speech.length) {
    const level = Math.sqrt(speech.reduce((a, r) => a + r * r, 0) / speech.length);
    const g = Math.max(0.5, Math.min(16, TARGET / level));
    for (let i = 0; i < n; i++) x[i] *= g;
  }
  // 3. limiter: the gain needed per sample, ramped down 3 ms ahead of each peak, released over 80 ms
  const look = Math.round(0.003 * sr), rel = 1 - Math.exp(-1 / (0.08 * sr)), g = new Float32Array(n);
  let a = 1;
  for (let i = n - 1; i >= 0; i--) {
    const need = Math.abs(x[i]) > CEIL ? CEIL / Math.abs(x[i]) : 1;
    a = Math.min(need, a + 1 / look);
    g[i] = a;
  }
  let cur = 1;
  for (let i = 0; i < n; i++) {
    cur = Math.min(g[i], cur + (1 - cur) * rel);
    const v = x[i] * cur;
    x[i] = v > CEIL ? CEIL : v < -CEIL ? -CEIL : v;
  }
}

// ---- live: the mic through the voice and the clean-up, for the recorded video ------------------------------------
// -> {track (the processed audio track), update(settings), monitor(on), close()}. Falls back to the plain chain
// (no voice) where AudioWorklet is missing.
export async function createLiveVoice(ac, micTrack, s) {
  const src = ac.createMediaStreamSource(new MediaStream([micTrack]));
  const hp = ac.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 80; hp.Q.value = 0.707;
  let fx = null;
  try {
    await ensureWorklet(ac);
    fx = new AudioWorkletNode(ac, "eliran-voice", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: "explicit", processorOptions: { settings: params(s, ac.sampleRate, true) } });
  } catch (e) { console.warn("voice worklet", e); }
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -24; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.2;
  const makeup = ac.createGain(); makeup.gain.value = fx ? 1 : 2; // with the worklet its agc sets the level
  const lim = ac.createDynamicsCompressor();
  lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
  const dest = ac.createMediaStreamDestination();
  const mon = ac.createGain(); mon.gain.value = 0;
  src.connect(hp);
  (fx ? hp.connect(fx) : hp).connect(comp);
  comp.connect(makeup).connect(lim);
  lim.connect(dest); lim.connect(mon); mon.connect(ac.destination);
  return {
    track: dest.stream.getAudioTracks()[0],
    fx: !!fx,
    update(next) { fx?.port.postMessage(params(next, ac.sampleRate, true)); },
    monitor(on) { mon.gain.value = on ? 1 : 0; },
    close() { try { src.disconnect(); lim.disconnect(); mon.disconnect(); } catch { /* gone */ } dest.stream.getTracks().forEach((t) => t.stop()); },
  };
}
