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

export function pickType() {
  if (typeof MediaRecorder === "undefined") return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

// Records `seconds` and resolves {blob, type, ms}. onTick(secondsLeft) once a second.
export function record(canvas, audioTrack, seconds, onTick) {
  const type = pickType();
  if (type === null) return Promise.reject(new Error("no-recorder"));
  const stream = canvas.captureStream(30);
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
    rec.onerror = (e) => { clearInterval(tick); clearTimeout(stop); reject(e.error || new Error("recorder-error")); };
    rec.onstop = () => {
      clearInterval(tick); clearTimeout(stop);
      stream.getTracks().forEach((t) => t.stop()); // the clone and the canvas track; the live mic stays on
      const mime = rec.mimeType || type || "video/webm";
      resolve({ blob: new Blob(chunks, { type: mime }), type: mime, ms: performance.now() - t0 });
    };
    rec.start(1000);
  });
}
