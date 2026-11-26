// Offline render of an edited take (docs/phone_recording.md, "Offline render"): time steps at exactly 1/fps, the pose
// from the performance file (take.js PoseTrack, interpolated), camera/effects/background from the edit (edit.js), one
// WebGL render per frame, H.264 through WebCodecs VideoEncoder, the take's mic audio as AAC (AudioEncoder), muxed
// into MP4 with mp4-muxer. Nothing depends on how fast the phone is: a slow phone takes longer, the file is the same.
// Each frame is composed in 2D (layers.js): background color/image/video, images behind, Eliran, images in front.
// A background video (version 8, video.js) gives the exact frame of each output frame (the render waits for it), and
// its sound is mixed with the voice (layers.js mixAudio, the same mix the editor plays).
// Hat physics (spring bones) run on a fixed 1/60 s step from a settled start, so two renders give the same frames.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { sceneAt, applyScene } from "./edit.js?v=8";
import { processVoice } from "./voice.js?v=8";
import { composite, mixAudio, videoNeeds } from "./layers.js?v=8";
import { audioOf } from "./video.js?v=8";

const PHYS_DT = 1 / 60, SETTLE = 90; // physics step; steps at the start pose before frame 0 so the hat is at rest
export const SIZES = { "720": [720, 1280], "1080": [1080, 1920] };

// H.264 profiles to try, best first. Level 4.2 covers 1080x1920 at 60 fps; the level is only an upper bound.
const AVC = ["avc1.64002A", "avc1.4D402A", "avc1.42002A", "avc1.640028", "avc1.4D4028", "avc1.42E028", "avc1.42E01F"];
async function pickVideoConfig(w, h, fps, bitrate) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const codec of AVC) {
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"]) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: "avc" }, latencyMode: "quality",
                    bitrateMode: "variable", hardwareAcceleration };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
    }
  }
  return null;
}
async function pickAudioConfig(sampleRate, numberOfChannels) {
  if (typeof AudioEncoder === "undefined") return null;
  for (const [codec, mux] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const cfg = { codec, sampleRate, numberOfChannels, bitrate: 160_000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch { /* next */ }
  }
  return null;
}

// What this browser can do, for the render sheet: {video: bool, audio: "aac"|"opus"|null}.
export async function support() {
  const v = await pickVideoConfig(720, 1280, 30, 8e6);
  const a = await pickAudioConfig(48000, 1);
  return { video: !!v, audio: a?.mux ?? null, codec: v?.codec ?? null };
}

// voice = voice.js settings (the sound is processed at render time from the raw mic in the performance file)
// bitmaps = the edit's decoded images (layers.js, Map id -> ImageBitmap); videos = Map id -> VideoSource (video.js)
// opts: {size: "720"|"1080", fps: 30|60, ss: 1|2, onProgress({frame, frames, fps}), signal: {cancel}}
// -> {blob (video/mp4), ms, frames, fps, w, h, codec, audio}
export async function renderTake({ stage, pose, edit, take, opts, voice, bitmaps, videos }) {
  const [w, h] = SIZES[opts.size] || SIZES["720"], fps = opts.fps || 30, ss = opts.ss || 1;
  const durationMs = take.header.durationMs, frames = Math.max(1, Math.round(durationMs / 1000 * fps));
  const bitrate = Math.round((w * h * fps) * (fps > 30 ? 0.12 : 0.16)); // ~8.8 Mbps 720p60, ~10 Mbps 1080p30
  const vcfg = await pickVideoConfig(w, h, fps, bitrate);
  if (!vcfg) throw new Error("no-h264");

  // ---- audio: the mic file decoded and processed, plus the background videos' sound, mixed on the take clock
  // (the voice shifted by audio.startMs after t0), cut to the video length
  let audio = null;
  try {
    let vbuf = null;
    if (take.audio) {
      try {
        const ac = new OfflineAudioContext(1, 1, 48000);
        const raw = await ac.decodeAudioData(await take.audio.arrayBuffer());
        vbuf = await processVoice(raw, voice); // the voice changer + clean-up (voice.js), the delay removed
      } catch (e) { console.warn("render voice", e); }
    }
    const sr = vbuf?.sampleRate || 48000, sounds = new Map();
    for (const [id, src] of videos || []) if (src?.audio && src.blob) sounds.set(id, await audioOf(src.blob, sr));
    const buf = mixAudio({ voice: vbuf, voiceStart: take.header.audio?.startMs ?? 0, edit, sounds, lengthMs: frames * 1000 / fps, sampleRate: sr });
    const acfg = buf && await pickAudioConfig(buf.sampleRate, buf.numberOfChannels);
    if (acfg) audio = { buf, ...acfg };
  } catch (e) { console.warn("render audio", e); }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    audio: audio ? { codec: audio.mux, numberOfChannels: audio.buf.numberOfChannels, sampleRate: audio.buf.sampleRate } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let fail = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { fail = e; } });
  venc.configure(vcfg);

  // ---- the frames
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const g = out.getContext("2d", { alpha: false });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  stage.setSize(w * ss, h * ss);
  stage.background(null); // Eliran on a transparent clear; the background is a layer
  const vrm = stage.vrm, gl = stage.renderer.domElement;
  const setAt = (t) => { pose.at(t); applyScene(stage, sceneAt(edit, t, stage)); };
  try {
    vrm.springBoneManager?.reset();
    setAt(0);
    for (let i = 0; i < SETTLE; i++) vrm.update(PHYS_DT);
    let physT = 0; // ms
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      if (opts.signal?.cancel) throw new Error("cancel");
      if (fail) throw fail;
      const t = f * 1000 / fps;
      // physics: fixed 1/60 s steps up to this frame, the pose/effects set at each step's time
      while (physT + PHYS_DT * 1000 <= t + 1e-6) {
        physT += PHYS_DT * 1000;
        setAt(physT);
        vrm.update(PHYS_DT);
      }
      // 30 and 60 fps land on the 1/60 grid, so the last step above was at exactly t (frame 0 = the settled start).
      // Off the grid: the pose of t without another physics step (vrm.update(0) would still move the springs).
      if (Math.abs(physT - t) > 1e-3 && f > 0) {
        setAt(t);
        vrm.humanoid.update(); vrm.expressionManager?.update(); vrm.nodeConstraintManager?.update();
      }
      stage.renderer.render(stage.scene, stage.camera);
      for (const n of videoNeeds(edit, t)) { const v = videos?.get(n.vid); if (v) await v.frameAt(n.ms); } // exact frames
      composite(g, w, h, edit, t, gl, bitmaps, {}, videos); // ss = 2: Eliran scaled down, each output pixel = 2x2 rendered pixels
      window.__rec?.probeRender?.(f, g); // local tests only: read the composed frame before encoding
      const frame = new VideoFrame(out, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 1));
      if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // let the page draw the progress
      while (document.hidden) await new Promise((r) => setTimeout(r, 300)); // the phone stops the GPU in the background
      opts.onProgress?.({ frame: f + 1, frames, fps: (f + 1) / ((performance.now() - t0) / 1000) });
    }
    await venc.flush();
    if (fail) throw fail;

    if (audio) await encodeAudio(audio, 0, frames * 1000 / fps, muxer); // the mix is on the take clock already
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
    return { blob, ms: frames * 1000 / fps, frames, fps, w, h, codec: vcfg.codec, audio: audio?.mux ?? null };
  } finally {
    try { venc.close(); } catch { /* closed */ }
    stage.setSize(720, 1280);
  }
}

async function encodeAudio(audio, startMs, lengthMs, muxer) {
  const { buf, cfg } = audio, sr = buf.sampleRate, ch = buf.numberOfChannels;
  const total = Math.round(lengthMs / 1000 * sr), shift = Math.round(startMs / 1000 * sr); // video sample i = audio i - shift
  let fail = null;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { fail = e; } });
  enc.configure(cfg);
  const CH = 4096, src = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  for (let i = 0; i < total; i += CH) {
    const n = Math.min(CH, total - i), data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) {
      const s = src[c], o = c * n;
      for (let k = 0; k < n; k++) { const j = i + k - shift; data[o + k] = j >= 0 && j < s.length ? s[j] : 0; }
    }
    const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: ch,
                               timestamp: Math.round(i / sr * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (fail) throw fail;
  }
  await enc.flush();
  enc.close();
  if (fail) throw fail;
}
