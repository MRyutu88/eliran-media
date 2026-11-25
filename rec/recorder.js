// Recording: the canvas (captureStream) + an audio track -> MediaRecorder (docs/phone_recording.md, "Recording").
// MP4 when the browser can make it (newer Android Chrome; Instagram takes it as is), otherwise WebM.
// A live take also records the mic alone (a second MediaRecorder) for the performance file (take.js).

const TYPES = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

// The canvas track of the running recording. The loop calls frameDrawn() right after each render, so the video
// gets exactly the frames that were drawn, each once, at its real time (a fixed captureStream(30) against a
// ~40 fps render gave uneven 33/66 ms frames: the judder seen on the phone, 25.11).
let liveTrack = null;
export function frameDrawn() { liveTrack?.requestFrame?.(); }

export function pickType() {
  if (typeof MediaRecorder === "undefined") return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}
const pickAudioType = () => AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

function collect(rec, fallbackType) {
  const chunks = [];
  let startAt = null;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstart = () => { startAt = performance.now(); };
  return new Promise((resolve, reject) => {
    rec.onerror = (e) => reject(e.error || new Error("recorder-error"));
    rec.onstop = () => {
      const type = rec.mimeType || fallbackType;
      resolve({ blob: new Blob(chunks, { type }), type, startAt });
    };
  });
}

// Starts recording at once. Returns {t0, stop(), done}: t0 = performance.now() when both recorders were started (the
// time base of the performance file), stop() ends the take, done resolves
// {video: {blob, type, startMs}, audio: {blob, type, startMs} | null, ms}. startMs = the recorder's own start event
// relative to t0. Stops by itself after maxMs. onTick(elapsedMs) ~4 times a second.
// separateAudio: also record an audio track alone (live takes; a replay re-record already has its audio in the file):
// rawTrack when given (the mic before the voice changer, so the voice can be changed later), else audioTrack.
export function startRecording(canvas, audioTrack, { maxMs, onTick, separateAudio = false, rawTrack = null } = {}) {
  const type = pickType();
  if (type === null) throw new Error("no-recorder");
  // captureStream(0) = only on requestFrame(); where requestFrame is missing, captureStream() takes a frame
  // whenever the canvas changes, which is also one per render.
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  if (typeof track?.requestFrame !== "function") { track?.stop(); stream = canvas.captureStream(); track = null; }
  if (audioTrack) stream.addTrack(audioTrack.clone());
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
  const videoDone = collect(rec, type || "video/webm");

  let arec = null, aStream = null, audioDone = Promise.resolve(null);
  const sepTrack = rawTrack || audioTrack;
  if (separateAudio && sepTrack) {
    const at = pickAudioType();
    aStream = new MediaStream([sepTrack.clone()]);
    arec = new MediaRecorder(aStream, { ...(at ? { mimeType: at } : {}), audioBitsPerSecond: 128_000 });
    audioDone = collect(arec, at || "audio/webm");
  }

  const t0 = performance.now();
  liveTrack = track;
  rec.start(1000);
  arec?.start(1000);
  const tick = setInterval(() => onTick?.(performance.now() - t0), 250);
  let ended = false, stopAt = null;
  function stop() {
    if (ended) return;
    ended = true;
    stopAt = performance.now();
    clearInterval(tick); clearTimeout(cap);
    liveTrack = null;
    if (rec.state !== "inactive") rec.stop();
    if (arec && arec.state !== "inactive") arec.stop();
  }
  const cap = setTimeout(stop, maxMs ?? 90_000);
  const done = Promise.all([videoDone, audioDone]).then(([v, a]) => {
    stream.getTracks().forEach((t) => t.stop()); // the clones and the canvas track; the live mic stays on
    aStream?.getTracks().forEach((t) => t.stop());
    const rel = (x) => (x.startAt == null ? null : x.startAt - t0);
    return {
      video: { blob: v.blob, type: v.type, startMs: rel(v) },
      audio: a && a.blob.size ? { blob: a.blob, type: a.type, startMs: rel(a) } : null,
      ms: (stopAt ?? performance.now()) - t0,
    };
  }).catch((e) => { stop(); throw e; });
  return { t0, stop, done };
}
