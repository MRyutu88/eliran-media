// Recording: the canvas (captureStream) + the microphone track -> MediaRecorder (docs/phone_recording.md, "Recording").
// MP4 when the browser can make it (newer Android Chrome; Instagram takes it as is), otherwise WebM.

const TYPES = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

// The canvas track of the running recording. The loop calls frameDrawn() right after each render, so the video
// gets exactly the frames that were drawn, each once, at its real time (a fixed captureStream(30) against a
// ~40 fps render gave uneven 33/66 ms frames: the judder seen on the phone, 25.11).
let liveTrack = null;
export function frameDrawn() { liveTrack?.requestFrame?.(); }

export function pickType() {
  if (typeof MediaRecorder === "undefined") return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

// Records `seconds` and resolves {blob, type, ms}. onTick(secondsLeft) once a second.
export function record(canvas, audioTrack, seconds, onTick) {
  const type = pickType();
  if (type === null) return Promise.reject(new Error("no-recorder"));
  // captureStream(0) = only on requestFrame(); where requestFrame is missing, captureStream() takes a frame
  // whenever the canvas changes, which is also one per render.
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  if (typeof track?.requestFrame !== "function") { track?.stop(); stream = canvas.captureStream(); track = null; }
  liveTrack = track;
  if (audioTrack) stream.addTrack(audioTrack.clone());
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let left = seconds;
    onTick?.(left);
    const tick = setInterval(() => { left -= 1; onTick?.(Math.max(0, left)); }, 1000);
    const stop = setTimeout(() => rec.state !== "inactive" && rec.stop(), seconds * 1000);
    rec.onerror = (e) => { clearInterval(tick); clearTimeout(stop); liveTrack = null; reject(e.error || new Error("recorder-error")); };
    rec.onstop = () => {
      clearInterval(tick); clearTimeout(stop); liveTrack = null;
      stream.getTracks().forEach((t) => t.stop()); // the clone and the canvas track; the live mic stays on
      const mime = rec.mimeType || type || "video/webm";
      resolve({ blob: new Blob(chunks, { type: mime }), type: mime, ms: performance.now() - t0 });
    };
    rec.start(1000);
  });
}
