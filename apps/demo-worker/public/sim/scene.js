// Low-poly scene. Uses three.module.min.js and the local Pretendard.

import * as THREE from "three";

const SIGN_GLYPHS = "민원실 (모의) 123번 창구 번호표 위임장";
const WAIT_T = 0.72;

const CAMERA_MODES = { base: { pos: [12.5, 5.2, 7.5], lookAt: [6.4, 1.8, -2.6] }, zoom: { pos: [10.4, 4.3, 4.8], lookAt: [6.8, 1.9, -2.8] }, result: { pos: [14.0, 5.2, 7.5], lookAt: [7.9, 1.8, -2.6] } };

const SIGN_PLANES_3D = [
  { name: "main", x0: 1.5, x1: 10.5, y0: 3.5, y1: 4.9, z: -6.8 },
  { name: "counter-1", x0: 1.8, x1: 3.2, y0: 3.25, y1: 3.85, z: -2.5 },
  { name: "counter-2", x0: 6.3, x1: 7.7, y0: 3.25, y1: 3.85, z: -2.5 },
  { name: "counter-3", x0: 10.8, x1: 12.2, y0: 3.25, y1: 3.85, z: -2.5 },
];

function createLabelMaterial(text, w, h, bg, fg, size, border = "") {
  const canvas = document.createElement("canvas");
  canvas.width = w * 4;
  canvas.height = h * 4;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 24;
    ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
  }
  ctx.fillStyle = fg;
  ctx.font = "800 " + size * 4 + 'px Pretendard, "Noto Sans KR", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: texture });
}

function loadPretendardForSigns() {
  if (typeof document === "undefined" || !document.fonts || typeof document.fonts.load !== "function") {
    return Promise.resolve();
  }
  return Promise.all([document.fonts.load("800 46px Pretendard"), document.fonts.load("800 46px Pretendard", SIGN_GLYPHS)]).catch(() => {});
}

export function canUseWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function createOfficeScene(container) {
  const width = Math.max(320, container.clientWidth || 1824);
  const height = Math.max(180, container.clientHeight || 780);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#eae8e3");
  scene.fog = new THREE.Fog("#eae8e3", 32, 74);

  const M = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.82, ...opts });
  function add(geo, mat, x, y, z, cast = true) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  scene.add(new THREE.HemisphereLight("#ffffff", "#dcdad5", 1.55));
  const sun = new THREE.DirectionalLight("#ffffff", 1.95);
  sun.position.set(6, 14, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 16, bottom: -16 });
  scene.add(sun);

  add(new THREE.BoxGeometry(30, 0.2, 18), M("#dedcd7", { roughness: 0.88 }), 6, -0.1, 0, false);
  add(new THREE.BoxGeometry(30, 7, 0.3), new THREE.MeshBasicMaterial({ color: "#f0eeea" }), 6, 3.5, -7, false);
  add(new THREE.BoxGeometry(30, 0.9, 0.32), M("#8b1538"), 6, 5.6, -6.98);
  add(new THREE.BoxGeometry(14, 1.2, 1.4), M("#ffffff"), 7, 0.6, -3.2);
  add(new THREE.BoxGeometry(14.2, 0.12, 1.6), M("#8b1538"), 7, 1.26, -3.2);

  let clerk2StampHand = null;
  let clerk2Head = null;
  for (let i = 0; i < 3; i++) {
    const x = 2.5 + i * 4.5;
    add(new THREE.BoxGeometry(0.08, 1.6, 1.4), M("#d5d3ce"), x - 2.2, 2.1, -3.2);
    add(new THREE.PlaneGeometry(3.6, 1.5), new THREE.MeshStandardMaterial({ color: "#dff1f5", transparent: true, opacity: 0.28 }), x, 2.1, -2.55, false);
    add(new THREE.CapsuleGeometry(0.42, 0.86, 6, 16), M("#5d6b7a"), x, 1.64, -4.3);

    const headGroup = new THREE.Group();
    headGroup.position.set(x, 2.66, -4.3);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.36, 24, 16), M("#e9c9a8"));
    skull.castShadow = true;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.375, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.46), M("#2c3744"));
    hair.position.set(0, 0.05, -0.03);
    hair.rotation.x = -0.24;
    const eyeGeo = new THREE.SphereGeometry(0.036, 12, 10);
    const eyeMat = M("#1a1a1a");
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.11, 0.02, 0.34);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.11, 0.02, 0.34);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), M("#d9b28c"));
    nose.position.set(0, -0.05, 0.36);
    headGroup.add(skull, hair, eyeL, eyeR, nose);
    scene.add(headGroup);

    add(new THREE.BoxGeometry(0.9, 0.55, 0.06), M("#2b2b2b"), x - 0.6, 1.62, -3.75);

    if (i === 1) {
      clerk2Head = headGroup;
      const handGroup = new THREE.Group();
      handGroup.position.set(x + 0.52, 2.22, -3.32);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.38, 6, 12), M("#5d6b7a"));
      arm.rotation.x = Math.PI / 3;
      arm.position.set(0, 0.14, -0.22);
      const fist = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), M("#e9c9a8"));
      fist.position.set(0, 0.08, 0);
      const stampHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.3, 16), M("#8b1538"));
      stampHandle.position.set(0, -0.07, 0);
      const stampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 16), M("#2b2b2b"));
      stampBase.position.set(0, -0.23, 0);
      handGroup.add(arm, fist, stampHandle, stampBase);
      scene.add(handGroup);
      clerk2StampHand = handGroup;
    }
  }

  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 6; i++) {
      const x = 2 + i * 1.6;
      const z = 1.6 + r * 2.2;
      add(new THREE.BoxGeometry(1.2, 0.12, 1.0), M("#b23a5c"), x, 0.7, z);
      add(new THREE.BoxGeometry(1.2, 0.9, 0.12), M("#b23a5c"), x, 1.15, z + 0.48);
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.7), M("#777777"), x, 0.35, z);
    }
  }

  add(new THREE.BoxGeometry(0.9, 1.8, 0.7), M("#ffffff"), -1.4, 0.9, -1.5);
  add(new THREE.BoxGeometry(9, 0.2, 9), M("#c8a77f"), -13, -0.05, 1, false);
  add(new THREE.BoxGeometry(9, 5, 0.3), M("#f2e8da"), -13, 2.5, -3.5);
  add(new THREE.BoxGeometry(2.2, 1, 1.6), M("#7d8f73"), -13.5, 0.5, 0.6);
  add(new THREE.BoxGeometry(2.2, 1.6, 0.4), M("#7d8f73"), -13.5, 1.3, -0.1);
  add(new THREE.CapsuleGeometry(0.42, 0.8, 6, 16), M("#c9b49a"), -13.5, 1.55, 0.6);
  add(new THREE.SphereGeometry(0.36, 24, 16), M("#e9c9a8"), -13.5, 2.55, 0.6);
  add(new THREE.SphereGeometry(0.37, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), M("#f2f2f2"), -13.5, 2.62, 0.55);
  add(new THREE.BoxGeometry(0.32, 0.55, 0.05), new THREE.MeshStandardMaterial({ color: "#1a1a1a", emissive: "#8b1538", emissiveIntensity: 0.6 }), -13.05, 1.85, 1.1);
  add(new THREE.CylinderGeometry(0.9, 0.9, 0.08, 32), M("#a98a64"), -10.8, 0.9, 1.2);
  add(new THREE.CylinderGeometry(0.08, 0.08, 0.9), M("#a98a64"), -10.8, 0.45, 1.2);

  const path = new THREE.CatmullRomCurve3([new THREE.Vector3(-11, 0.02, 2.4), new THREE.Vector3(-4, 0.02, 2.6), new THREE.Vector3(3.8, 0.02, 1.0), new THREE.Vector3(7, 0.02, -1.6)]);
  for (let i = 0; i <= 36; i++) {
    const p = path.getPoint(i / 36);
    add(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 16), M("#8b1538", { emissive: "#8b1538", emissiveIntensity: 0.2 }), p.x, 0.03, p.z, false);
  }

  const agent = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 0.9, 8, 24), M("#8b1538", { roughness: 0.45, metalness: 0.1 }));
  body.position.y = 1.2;
  body.castShadow = true;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.22, 0.2), new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 0.6 }));
  visor.position.set(0, 1.62, 0.42);
  const ant = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshStandardMaterial({ color: "#ffd166", emissive: "#ffb703", emissiveIntensity: 1 }));
  ant.position.set(0, 2.35, 0);
  const docMesh = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, 0.04), M("#ffffff"));
  docMesh.position.set(-0.62, 1.22, 0.42);
  docMesh.rotation.set(0, 1.05, 0);
  docMesh.castShadow = true;
  docMesh.visible = false;
  agent.add(body, visor, ant, docMesh);
  scene.add(agent);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 200);
  const currentLookAt = new THREE.Vector3(...CAMERA_MODES.base.lookAt);

  function render() {
    renderer.render(scene, camera);
  }

  function setCameraTransition(fromMode, toMode, progress) {
    const a = CAMERA_MODES[fromMode] || CAMERA_MODES.base;
    const b = CAMERA_MODES[toMode] || CAMERA_MODES.base;
    const t = Math.max(0, Math.min(1, progress));
    camera.position.set(a.pos[0] + (b.pos[0] - a.pos[0]) * t, a.pos[1] + (b.pos[1] - a.pos[1]) * t, a.pos[2] + (b.pos[2] - a.pos[2]) * t);
    currentLookAt.set(a.lookAt[0] + (b.lookAt[0] - a.lookAt[0]) * t, a.lookAt[1] + (b.lookAt[1] - a.lookAt[1]) * t, a.lookAt[2] + (b.lookAt[2] - a.lookAt[2]) * t);
    camera.lookAt(currentLookAt);
    camera.updateMatrixWorld();
    render();
  }

  function setCameraMode(mode) {
    setCameraTransition(mode, mode, 1);
  }

  function setAgentPose(t, bobY = 0, hasMandate = false, faceCounter = false) {
    const clamped = Math.max(0, Math.min(1, t));
    const pt = path.getPoint(clamped);
    agent.position.set(pt.x, bobY, pt.z);
    docMesh.visible = Boolean(hasMandate);
    if (!hasMandate) {
      docMesh.scale.set(1, 1, 1);
      docMesh.position.set(-0.62, 1.22, 0.42);
      docMesh.rotation.set(0, 1.05, 0);
    }
    if (faceCounter || clamped >= 0.98) {
      agent.lookAt(7.45, bobY, -3.2);
    } else {
      const nextPt = path.getPoint(Math.min(1, clamped + 0.03));
      agent.lookAt(nextPt.x, bobY, nextPt.z);
    }
    render();
  }

  function setMandatePop(progress) {
    const t = Math.max(0, Math.min(1, progress));
    docMesh.visible = t > 0.01;
    const bounce = Math.sin(t * Math.PI) * 0.28;
    const scale = Math.min(1, t * 1.25) + bounce * 0.45;
    docMesh.scale.set(scale, scale, scale);
    docMesh.position.set(-0.62, 0.72 + (1.22 - 0.72) * t + bounce, 0.42);
    docMesh.rotation.set(0, 1.05, 0);
    render();
  }

  function setMandateExtend(amount, hasMandate = true) {
    if (!hasMandate) {
      docMesh.visible = false;
      render();
      return;
    }
    const t = Math.max(0, Math.min(1, amount));
    docMesh.visible = true;
    docMesh.scale.set(1, 1, 1);
    docMesh.position.set(-0.62 + t * 0.06, 1.22 + t * 0.24, 0.42 + t * 0.28);
    docMesh.rotation.set(t * 0.14, 1.05 - t * 0.72, -t * 0.06);
    render();
  }

  function setClerkStampPress(amount) {
    if (!clerk2StampHand) return;
    const t = Math.max(0, Math.min(1, amount));
    clerk2StampHand.position.y = 2.22 - t * 0.58;
    clerk2StampHand.rotation.x = t * 0.22;
    render();
  }

  function setClerkHeadMotion(nod = 0, shake = 0) {
    if (!clerk2Head) return;
    clerk2Head.rotation.x = nod * 0.42;
    clerk2Head.rotation.y = shake * 0.75;
    clerk2Head.rotation.z = -shake * 0.12;
    clerk2Head.position.x = 7 + shake * 0.14;
    render();
  }

  function projectToStage(x, y, z) {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    const v = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  function getOverlayAnchors() {
    const signRects = [];
    for (let i = 0; i < SIGN_PLANES_3D.length; i++) {
      const s = SIGN_PLANES_3D[i];
      const p1 = projectToStage(s.x0, s.y0, s.z);
      const p2 = projectToStage(s.x1, s.y0, s.z);
      const p3 = projectToStage(s.x0, s.y1, s.z);
      const p4 = projectToStage(s.x1, s.y1, s.z);
      signRects.push({ name: s.name, left: Math.min(p1.x, p2.x, p3.x, p4.x), top: Math.min(p1.y, p2.y, p3.y, p4.y), right: Math.max(p1.x, p2.x, p3.x, p4.x), bottom: Math.max(p1.y, p2.y, p3.y, p4.y) });
    }
    return {
      agentHead: projectToStage(agent.position.x, agent.position.y + 2.35, agent.position.z),
      agentBodyTop: projectToStage(agent.position.x, agent.position.y + 2.1, agent.position.z),
      clerkHead: projectToStage(7, 2.75, -4.3),
      clerkCrown: projectToStage(7, 3.05, -4.3),
      clerkRight: projectToStage(9.1, 2.45, -3.1),
      signRects,
    };
  }

  function resize() {
    const nextW = Math.max(320, container.clientWidth || 1824);
    const nextH = Math.max(180, container.clientHeight || 780);
    camera.aspect = nextW / nextH;
    camera.updateProjectionMatrix();
    renderer.setSize(nextW, nextH);
    render();
  }

  setCameraMode("base");
  setAgentPose(WAIT_T, 0, false, false);

  // Create the 3D sign labels only after document.fonts.load('800 46px Pretendard') finishes.
  const ready = loadPretendardForSigns().then(() => {
    add(new THREE.PlaneGeometry(9, 1.4), createLabelMaterial("민원실 (모의)", 900, 140, "#ffffff", "#8b1538", 80), 6, 4.2, -6.8, false);
    for (let i = 0; i < 3; i++) {
      add(new THREE.PlaneGeometry(1.4, 0.6), createLabelMaterial(String(i + 1) + "번 창구", 280, 120, "#1a1a1a", "#ffffff", 46), 2.5 + i * 4.5, 3.55, -2.5, false);
    }
    add(new THREE.PlaneGeometry(0.7, 0.4), createLabelMaterial("번호표", 140, 80, "#8b1538", "#ffffff", 40), -1.4, 1.5, -1.14, false);
    docMesh.material = createLabelMaterial("위임장", 110, 140, "#ffffff", "#8b1538", 28, "#8b1538");
    render();
  });

  return { ready, WAIT_T, render, resize, setCameraMode, setCameraTransition, setAgentPose, setMandatePop, setMandateExtend, setClerkStampPress, setClerkHeadMotion, getOverlayAnchors };
}
