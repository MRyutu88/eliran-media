// The 3D stage: renderer, lights, the VRM and the camera framing (docs/phone_recording.md, "Stage").
// The canvas has a fixed internal size (720x1280) so the recording and the GPU cost are the same on every phone;
// CSS only scales it to the screen.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

export const W = 720, H = 1280;
export const BG = "#3b1830"; // a dark plum (brand --plum is #5B2140); recorded as the clip's background

// Arms come in the rest (T) pose; lower them to the sides. Normalized bones: the model faces +Z, its left arm is +X,
// so rotating leftUpperArm about Z by a negative angle brings it down.
export const ARM_DOWN = 1.2, ELBOW = 0.2; // body.js writes the arms every frame from these

export function createStage(canvas) {
  // alpha: the editor and the render clear to transparent and draw the background as a 2D layer (layers.js); live,
  // the scene background is an opaque color, so the canvas stays opaque.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; // PBR materials (Metallic=1 parts) need it
  scene.environmentIntensity = 0.7;
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(0.6, 1.4, 1.6);
  scene.add(key, new THREE.HemisphereLight(0xfff6ee, 0x5b2140, 0.7));

  const camera = new THREE.PerspectiveCamera(28, W / H, 0.01, 30);
  camera.position.set(0, 0.5, 2);

  let vrm = null, framing = "body";
  // Measured once per model in the rest pose (load): the two framings as {y, dist, z} and the model's size, so the
  // editor's camera keys and effects (edit.js) do not depend on the current head pose.
  let shots = null, size = null;
  // place() = the editor effect, setBody() = body.js (offset + squash); the model gets both combined.
  let fx = null, body = { x: 0, y: 0, sx: 1, sy: 1 };

  async function load(arrayBuffer) {
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.parseAsync(arrayBuffer, "");
    const v = gltf.userData.vrm;
    if (!v) throw new Error("not-vrm");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    if (v.meta?.metaVersion === "0") VRMUtils.rotateVRM0(v); // VRM 0.x faces -Z
    v.scene.traverse((o) => { o.frustumCulled = false; });
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = v;
    scene.add(vrm.scene);
    fx = null; body = { x: 0, y: 0, sx: 1, sy: 1 };
    restPose();
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    size = { w: box.max.x - box.min.x, h: box.max.y - box.min.y, top: box.max.y, bottom: box.min.y };
    shots = { body: shot("body"), close: shot("close") };
    frame();
    return vrm;
  }

  function restPose() {
    const h = vrm.humanoid, set = (name, z) => { const b = h.getNormalizedBoneNode(name); if (b) b.rotation.z = z; };
    set("leftUpperArm", -ARM_DOWN); set("rightUpperArm", ARM_DOWN);
    set("leftLowerArm", -ELBOW); set("rightLowerArm", ELBOW);
  }

  // body (default) = the whole chibi, as large as the head's width allows: in 9:16 the head is almost as wide as the
  // frame, so keeping it whole already shows the whole body. close = head and chest filling the frame; the brim tip
  // and the ear go past the edges.
  function shot(mode) {
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const pos = (n) => vrm.humanoid.getNormalizedBoneNode(n)?.getWorldPosition(new THREE.Vector3());
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect;
    const top = box.max.y + 0.03;
    let dist, camY;
    if (mode === "close") {
      const bottom = (pos("spine")?.y ?? box.min.y) - 0.02;
      dist = ((top - bottom) / 2) / tanV * 1.04;
      camY = (top + bottom) / 2;
    } else {
      const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) + 0.03;
      const bottom = box.min.y - 0.03;
      dist = Math.max(halfW / tanH, ((top - bottom) / 2) / tanV) * 1.04;
      camY = Math.min((top + bottom) / 2, top + 0.02 - dist * tanV * 0.95); // head near the top
    }
    return { x: 0, y: camY, dist, z: pos("head")?.z ?? 0 };
  }
  function frame(mode = framing) {
    framing = mode;
    if (!vrm) return;
    view(shot(mode));
  }
  // The camera at {x, y, dist, z}: looking straight along -Z at (x, y, z) from dist away.
  function view(c) {
    camera.position.set(c.x, c.y, c.z + c.dist);
    camera.lookAt(c.x, c.y, c.z);
  }
  // Effects (edit.js): an offset/turn/scale on the whole model, and hidden when out of frame. All zero = as recorded.
  function place(f) { fx = f; compose(); }
  // body.js: {x, y (metres), sx, sy}, the squash pivot is the model's origin (the feet).
  function setBody(b) { body = b; compose(); }
  function compose() {
    if (!vrm) return;
    const o = vrm.scene, sx = (fx?.sx ?? 1) * body.sx;
    o.position.set((fx?.x ?? 0) + body.x, (fx?.y ?? 0) + body.y, 0);
    o.rotation.set(0, fx?.rotY ?? 0, 0);
    o.scale.set(sx, (fx?.sy ?? 1) * body.sy, sx);
    o.visible = !fx?.hidden;
  }
  // a color, or null = transparent (the editor / render layers)
  function background(color) { scene.background = color ? new THREE.Color(color) : null; }
  // Internal canvas size (the offline render uses 1080x1920 or 2x supersampling); always 9:16.
  function setSize(w, h) { renderer.setSize(w, h, false); }

  function render(dt) {
    if (vrm) vrm.update(dt);
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, load, frame, view, place, setBody, background, setSize, render,
           get vrm() { return vrm; }, get framing() { return framing; }, get shots() { return shots; }, get size() { return size; } };
}
