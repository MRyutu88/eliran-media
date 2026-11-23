// The 3D stage: renderer, lights, the VRM and the camera framing (docs/phone_recording.md, "Stage").
// The canvas has a fixed internal size (720x1280) so the recording and the GPU cost are the same on every phone;
// CSS only scales it to the screen.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

export const W = 720, H = 1280;
const BG = "#3b1830"; // a dark plum (brand --plum is #5B2140); recorded as the clip's background

// Arms come in the rest (T) pose; lower them to the sides. Normalized bones: the model faces +Z, its left arm is +X,
// so rotating leftUpperArm about Z by a negative angle brings it down.
const ARM_DOWN = 1.2, ELBOW = 0.2;

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
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
    restPose();
    vrm.update(0);
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
  function frame(mode = framing) {
    framing = mode;
    if (!vrm) return;
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
    const z = pos("head")?.z ?? 0;
    camera.position.set(0, camY, z + dist);
    camera.lookAt(0, camY, z);
  }

  function render(dt) {
    if (vrm) vrm.update(dt);
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, load, frame, render, get vrm() { return vrm; }, get framing() { return framing; } };
}
