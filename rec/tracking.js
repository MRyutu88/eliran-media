// Face tracking: MediaPipe Face Landmarker on the front camera (docs/phone_recording.md, "Tracking").
// 52 ARKit-style blendshapes + a 4x4 head transform per frame. GPU delegate first, CPU if the phone refuses it.
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export async function createTracker() {
  const files = await FilesetResolver.forVisionTasks(WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  let landmarker, delegate = "GPU";
  try {
    landmarker = await FaceLandmarker.createFromOptions(files, options("GPU"));
  } catch (e) {
    console.warn("GPU delegate failed, using CPU", e);
    delegate = "CPU";
    landmarker = await FaceLandmarker.createFromOptions(files, options("CPU"));
  }

  let lastTime = -1, lastStamp = 0;
  // Returns null when there is no new video frame; {face: null} when a frame had no face.
  function detect(video) {
    if (video.readyState < 2 || video.currentTime === lastTime) return null;
    lastTime = video.currentTime;
    const stamp = Math.max(performance.now(), lastStamp + 1); // timestamps must grow
    lastStamp = stamp;
    const t0 = performance.now();
    const r = landmarker.detectForVideo(video, stamp);
    const ms = performance.now() - t0;
    if (!r.faceBlendshapes?.length) return { face: null, ms };
    const shapes = {};
    for (const c of r.faceBlendshapes[0].categories) shapes[c.categoryName] = c.score;
    return { face: { shapes, matrix: r.facialTransformationMatrixes?.[0]?.data ?? null }, ms };
  }

  return { delegate, detect, close: () => landmarker.close() };
}
