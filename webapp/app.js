// 3DGS 다시점 거리 측정기 — Deng & Qin (2026) 다시점 공간교회(spatial intersection)를 브라우저에서 구현
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { ERRORS, QUALITY } from './errors.js';
import { startTour, TOUR_STEPS } from './tour.js';

const $ = (s) => document.querySelector(s);
const FILE_MODE = location.protocol === 'file:'; // 더블클릭(단일 파일 버전)으로 열림: fetch 불가 → 샘플 숨김
const $$ = (s) => Array.from(document.querySelectorAll(s));
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ 상태
const state = {
  file: null, header: null, mesh: null, bounds: null, centers: null, coordOffset: null, cloud: null, points3: null,
  unit: { known: false, factor: 1, sigmaRel: 0, source: '' },
  upSource: null,
  task: null,            // {kind:'point'|'distance'|'calib', pts:[], trueLen?}
  rays: [], estimate: null, refPatch: null, autoRotCount: 0,
  points: [], dists: [], geoms: [], selected: new Set(), nextId: 1, nextGeomId: 1,
  settings: { n: 5, snap: true, refine: true, loupe: true, zoom: 2, loupeSize: 'm', loupeHiRes: true, autoRotate: true, rotAxis: 'screen', rotPattern: 'right', rotStep: 0, navpad: true, navStep: 15, viewMode: 'splat', ptSize: 1, ptMode: 'dense', ptScale: 0.7, ptMaxPx: 6, hideBig: true, densify: 'auto', cloudColor: 'rgb', pickSplat: false, pickMode: 'cluster', pickRadius: 8, pickHelpSeen: false, dunit: 'auto', labels: true },
  autoPivot: null, autoAngleDeg: 0, autoTiltDeg: 0, loupeHiResFailed: false, gcpInputs: {},
  mouse: { x: 0, y: 0, inside: false },
  webgl2: true,
};
window.__state = state; // 디버그/테스트용

// ------------------------------------------------------------------ 렌더러
const glHost = $('#gl');
let renderer, scene, camera, controls, spark;
function initGL() {
  const test = document.createElement('canvas').getContext('webgl2');
  if (!test) { state.webgl2 = false; showError('E01'); return false; }
  renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x05070d, 1);
  glHost.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
  camera.up.set(0, -1, 0);
  camera.position.set(0, -2, 6);
  spark = new SparkRenderer({ renderer });
  scene.add(spark);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = 0.7;
  controls.enableZoom = false; // 휠 줌은 아래 onWheel 이 표면 깊이를 알고 처리 (OrbitControls 는 표면을 몰라 뚫고 지나감)
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(loop);
  return true;
}
const overlay = $('#overlay'); const octx = overlay.getContext('2d');
function resize() {
  const w = glHost.clientWidth, h = glHost.clientHeight;
  if (!renderer || w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  overlay.style.width = w + 'px'; overlay.style.height = h + 'px';
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function viewSize() { return { w: glHost.clientWidth, h: glHost.clientHeight }; }
function updateClipPlanes() {
  const d = Math.max(1e-4, controls.target.distanceTo(camera.position)); const R = state.bounds?.radius || 10;
  const near = THREE.MathUtils.clamp(d * 0.02, 1e-4, R * 0.01); // 가까이 가면 near 도 함께 줄어 표면이 잘리지 않음
  if (Math.abs(camera.near - near) / near > 0.15) { camera.near = near; camera.far = Math.max(R * 300, near * 1e6); camera.updateProjectionMatrix(); }
}
function loop() {
  requestAnimationFrame(loop);
  tickAnimations();
  controls.update();
  if (state.bounds) updateClipPlanes();
  if (state.mesh || state.points3) renderer.render(scene, camera);
  drawOverlay();
  updateLoupe();
}

// ------------------------------------------------------------------ 카메라 유틸
const anims = [];
function animate(ms, fn, done) { anims.push({ t0: performance.now(), ms, fn, done }); }
function tickAnimations() {
  const now = performance.now();
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i]; let k = Math.min(1, (now - a.t0) / a.ms); const e = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k;
    a.fn(e); if (k >= 1) { anims.splice(i, 1); a.done && a.done(); }
  }
}
function moveTarget(newTarget, ms = 300) {
  const from = controls.target.clone(), to = newTarget.clone();
  animate(ms, (e) => { controls.target.lerpVectors(from, to, e); });
}
function frameAll() {
  if (!state.bounds) return;
  const { center, radius } = state.bounds; const up = camera.up.clone().normalize();
  let h = new THREE.Vector3(1, 0, 0); if (Math.abs(h.dot(up)) > 0.9) h.set(0, 1, 0);
  h.projectOnPlane(up).normalize(); const h2 = new THREE.Vector3().crossVectors(up, h).normalize();
  const az = 45 * DEG, el = 35 * DEG;
  const dir = h.multiplyScalar(Math.cos(az)).add(h2.multiplyScalar(Math.sin(az))).multiplyScalar(Math.cos(el)).add(up.clone().multiplyScalar(Math.sin(el)));
  camera.position.copy(center).add(dir.multiplyScalar(radius * 2.2));
  controls.target.copy(center);
  camera.near = Math.max(1e-4, radius * 0.02); camera.far = radius * 300; camera.updateProjectionMatrix();
  controls.update();
}
function setUp(v, source) {
  camera.up.copy(v).normalize(); state.upSource = source;
  // OrbitControls 는 생성 시점의 up 으로 회전축(_quat)을 고정하므로 up 변경 시 직접 갱신 (안 하면 회전이 옛 축으로 돎)
  if (controls._quat) { controls._quat.setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0)); controls._quatInverse.copy(controls._quat).invert(); }
  const names = { '0,-1,0': '−Y', '0,1,0': '+Y', '0,0,1': '+Z', '0,0,-1': '−Z', '1,0,0': '+X', '-1,0,0': '−X' };
  $('#up-label').textContent = names[[v.x, v.y, v.z].join(',')] || '사용자';
  if (state.bounds) frameAll();
}
function autoStepDeg() { return state.settings.rotStep > 0 ? state.settings.rotStep : 350 / Math.max(2, state.settings.n); }
// 회전축: 'screen' = 지금 보는 화면 기준(세로축=좌우 회전, 가로축=상하 회전), 'world' = 파일의 위(up) 방향 기준
function orbitAxis(kind) {
  if (state.settings.rotAxis === 'world') {
    const up = camera.up.clone().normalize(); if (kind === 'h') return up;
    return new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()), up).normalize();
  }
  return (kind === 'h' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).applyQuaternion(camera.quaternion).normalize();
}
// 측정 중인 점(피벗)을 중심으로 카메라를 궤도 회전. kind 'h': +deg = 카메라가 오른쪽으로, 'v': +deg = 카메라가 위로. 거리 유지, 피벗은 화면 중앙 고정.
function autoOrbit(deg, kind = 'h') {
  if (!state.task || !state.rays.length || !deg) return;
  if (state.estimate) state.autoPivot = state.estimate.p.clone();
  const pivot = state.autoPivot || refPoint(); if (!pivot) return;
  const axis = orbitAxis(kind); const angle = (kind === 'v' ? -deg : deg) * DEG;
  const off0 = camera.position.clone().sub(pivot);
  if (kind === 'v') { // 극점(바로 위/아래) 넘어가지 않게
    const up = camera.up.clone().normalize(); const off1 = off0.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    const phi = Math.acos(THREE.MathUtils.clamp(off1.clone().normalize().dot(up), -1, 1)) / DEG;
    if (phi < 6 || phi > 174) { toast('그 방향으로는 더 돌릴 수 없습니다(바로 위/아래).', 'warn', 2500); return; }
  }
  const tFrom = controls.target.clone(); const q = new THREE.Quaternion();
  animate(700, (e) => {
    q.setFromAxisAngle(axis, angle * e);
    camera.position.copy(pivot).add(off0.clone().applyQuaternion(q));
    controls.target.lerpVectors(tFrom, pivot, Math.min(1, e * 2));
    camera.lookAt(controls.target);
  }, () => { controls.target.copy(pivot); camera.lookAt(pivot); controls.update(); if (kind === 'h') state.autoAngleDeg += deg; else state.autoTiltDeg += deg; updateMeasureUI(); });
}
// 클릭 k(1..N-1) 뒤 이동할 목표 각도 (패턴별 절대각) → 현재 누적각과의 차이만큼 회전
function nextAutoStep(k) {
  const st = autoStepDeg(); const pat = state.settings.rotPattern;
  const alt = (i) => (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * st;
  if (pat === 'right') return { kind: 'h', deg: k * st - state.autoAngleDeg };
  if (pat === 'left') return { kind: 'h', deg: -k * st - state.autoAngleDeg };
  if (pat === 'alth') return { kind: 'h', deg: alt(k) - state.autoAngleDeg };
  return { kind: 'v', deg: Math.max(-70, Math.min(70, alt(k))) - state.autoTiltDeg };
}
function nextAutoLabel(k) { const n = nextAutoStep(k); if (!n.deg) return ''; const arrow = n.kind === 'h' ? (n.deg > 0 ? '⟳ 오른쪽' : '⟲ 왼쪽') : (n.deg > 0 ? '⇑ 위' : '⇓ 아래'); return `${arrow} ${Math.abs(n.deg).toFixed(0)}°`; }
function autoRotate() { const k = state.rays.length; const n = nextAutoStep(k); if (n.deg) autoOrbit(n.deg, n.kind); else autoOrbit(autoStepDeg(), 'h'); }
// 커서 광선 주변(각도 원뿔) 가우시안 중심들로 '커서 아래 표면 점'을 추정. state.centers 는 로드 시 저장한 표본(최대 20만 점)
// 반환: { t: 카메라로부터의 거리, point: 표면 점 군집의 3D 중심 } 또는 null
function surfaceHitAlongRay(o, d, pxRadius = 10) {
  const C = state.centers; if (!C) return null;
  const f = focalPx(); const tanA = pxRadius / f; const hits = [];
  for (let i = 0; i < C.length; i += 3) {
    const vx = C[i] - o.x, vy = C[i + 1] - o.y, vz = C[i + 2] - o.z;
    const t = vx * d.x + vy * d.y + vz * d.z; if (t <= 1e-6) continue;
    const perp2 = vx * vx + vy * vy + vz * vz - t * t; const lim = t * tanA;
    if (perp2 < lim * lim) hits.push({ t, i });
  }
  if (hits.length < 3) return pxRadius < 30 ? surfaceHitAlongRay(o, d, pxRadius * 2.5) : null;
  hits.sort((a, b) => a.t - b.t);
  // 가장 앞쪽 '점 군집'을 표면으로 택한다: 깊이가 12 % 안에 K점 이상 모인 첫 구간. 앞의 외톨이 잡티는 건너뛰고,
  // 커서가 물체를 살짝 벗어나도 뒤쪽 배경(바닥·벽)으로 튀지 않도록 앞 군집을 우선한다.
  const K = Math.max(3, Math.floor(hits.length * 0.03));
  let s0 = -1;
  for (let a = 0; a + K - 1 < hits.length; a++) { if (hits[a + K - 1].t <= hits[a].t * 1.12) { s0 = a; break; } }
  if (s0 < 0) s0 = Math.max(0, Math.floor(hits.length * 0.15) - Math.floor(K / 2));
  const pt = new THREE.Vector3(); let n = 0;
  for (let a = s0; a < Math.min(hits.length, s0 + K); a++) { const k = hits[a].i; pt.x += C[k]; pt.y += C[k + 1]; pt.z += C[k + 2]; n++; }
  pt.divideScalar(n);
  return { t: pt.distanceTo(o), point: pt };
}
function onWheel(e) {
  if (!state.mesh) return; e.preventDefault();
  const r = renderer.domElement.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
  let delta = e.deltaY; if (e.deltaMode === 1) delta *= 16; else if (e.deltaMode === 2) delta *= 400;
  zoomAt(px, py, delta);
}
// 화면 점 (px,py) 아래 표면을 향해 delta<0 이면 접근, >0 이면 후퇴 (휠 한 칸 ≈ 100)
function zoomAt(px, py, delta) {
  if (!state.mesh) return;
  const ray = rayFromPixel(px, py); const o = camera.position.clone();
  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  const tTarget = Math.max(1e-3, controls.target.clone().sub(o).dot(viewDir));
  let hit = surfaceHitAlongRay(o, ray.d);
  // 연속성: 마우스를 움직이지 않고 계속 굴리는 중에 커서가 물체를 비껴가 추정이 훨씩 먼 배경으로 넘어가면(1.5배 이상) 이전 깊이를 유지.
  // 마우스를 3 px 이상 움직였다면 새 대상으로 의도한 것으로 보고 새 추정을 따른다.
  const zm = state.zoomMouse; const mouseMoved = !zm || Math.hypot(px - zm.x, py - zm.y) > 3; state.zoomMouse = { x: px, y: py };
  if (hit && !mouseMoved && state.lastZoom && hit.t > 1.5 * tTarget) hit = null;
  // 이동 방향: 표면 점 군집의 중심을 향해 (커서 픽셀 정수 반올림 때문에 광선이 물체를 0.5 px 비껴가도, 보고 있던 표면 점이 화면에 고정됨)
  const dirMove = hit ? hit.point.clone().sub(o).normalize() : ray.d.clone();
  const tHit = hit ? hit.t : tTarget;                      // 표면을 못 찾으면 현재 궤도 중심 깊이
  const k = Math.min(3, Math.abs(delta) / 100);            // 휠 한 칸(≈100) 기준 배수
  const R = state.bounds?.radius || 1; const minGap = Math.max(R * 0.002, 1e-4);
  let move;
  if (delta < 0) { const remaining = tHit - minGap; if (remaining <= 0) return; move = remaining * (1 - Math.pow(0.88, k)); } // 남은 거리의 12 %씩 접근 → 표면을 절대 통과하지 않음
  else move = -tHit * (Math.pow(1 / 0.88, k) - 1);          // 멀어질 때는 비례해서 후퇴
  const hitPoint = hit ? hit.point.clone() : o.clone().addScaledVector(ray.d, tHit);
  state.lastZoom = { tHit, tTarget, move, px, py, hit: !!hit };
  camera.position.addScaledVector(dirMove, move);          // 표면 점을 향해 이동 → 그 점이 화면에서 고정
  const depth = Math.max(minGap, hitPoint.sub(camera.position).dot(viewDir));
  controls.target.copy(camera.position).addScaledVector(viewDir, depth); // 궤도 중심을 표면 깊이에 두어 회전이 그 점을 중심으로
  controls.update();
}
// ---------------- 플로팅 조작 패널 (마우스 없이 회전·확대·이동)
function navOrbit(dhDeg, dvDeg) { // 궤도 중심(controls.target)을 기준으로 화면 좌우/상하 회전
  if (!state.mesh) return;
  const pivot = controls.target.clone(); const off = camera.position.clone().sub(pivot);
  const up = camera.up.clone().normalize();
  if (dhDeg) off.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize(), dhDeg * DEG));
  if (dvDeg) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    const cand = off.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(right, -dvDeg * DEG));
    const phi = Math.acos(THREE.MathUtils.clamp(cand.clone().normalize().dot(up), -1, 1)) / DEG;
    if (phi > 4 && phi < 176) off.copy(cand);
  }
  camera.position.copy(pivot).add(off); camera.lookAt(pivot); controls.update();
}
function navPan(dxFrac, dyFrac) { // 화면 기준 평행이동 (궤도 중심 거리의 비율)
  if (!state.mesh) return;
  const dist = Math.max(1e-3, camera.position.distanceTo(controls.target));
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize(); const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
  const d = right.multiplyScalar(dxFrac * dist).add(upv.multiplyScalar(dyFrac * dist));
  camera.position.add(d); controls.target.add(d); controls.update();
}
function navZoom(dir) { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, dir > 0 ? -100 : 100); }
function navAction(act, fine = false) {
  const rot = fine ? 2 : (state.settings.navStep || 15), pan = fine ? 0.02 : 0.12;
  switch (act) {
    case 'rl': navOrbit(-rot, 0); break; case 'rr': navOrbit(rot, 0); break; case 'ru': navOrbit(0, rot); break; case 'rd': navOrbit(0, -rot); break;
    case 'zi': navZoom(fine ? 0.4 : 1); break; case 'zo': navZoom(fine ? -0.4 : -1); break;
    case 'pl': navPan(-pan, 0); break; case 'pr': navPan(pan, 0); break; case 'pu': navPan(0, pan); break; case 'pd': navPan(0, -pan); break;
    case 'home': frameAll(); break; case 'focus': { const rp = refPoint(); if (rp) moveTarget(rp); break; }
  }
}
function initNavpad() {
  const pad = $('#navpad'); if (!pad) return;
  let timer = null, held = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } held = null; };
  pad.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-nav]'); if (!b) return; e.preventDefault(); b.setPointerCapture?.(e.pointerId);
    const act = b.dataset.nav; navAction(act);
    if (['home', 'focus'].includes(act)) return;
    held = act; let n = 0; timer = setInterval(() => { n++; if (n > 6) navAction(held, true); }, 45); // 0.3초 이상 누르면 연속 미세 동작
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => pad.addEventListener(ev, stop));
  // 헤더 드래그로 위치 이동
  const head = pad.querySelector('.nav-head'); let drag = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = { x: e.clientX, y: e.clientY, l: pad.offsetLeft, t: pad.offsetTop }; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (!drag) return; const host = glHost.getBoundingClientRect(); pad.style.left = Math.max(0, Math.min(host.width - pad.offsetWidth, drag.l + e.clientX - drag.x)) + 'px'; pad.style.top = Math.max(0, Math.min(host.height - pad.offsetHeight, drag.t + e.clientY - drag.y)) + 'px'; pad.style.bottom = 'auto'; });
  head.addEventListener('pointerup', () => { if (drag) { try { localStorage.setItem('gsm.navpadPos', JSON.stringify({ left: pad.style.left, top: pad.style.top })); } catch (_) {} } drag = null; });
  $('#nav-fold').onclick = () => { pad.classList.toggle('folded'); $('#nav-fold').textContent = pad.classList.contains('folded') ? '▸' : '▾'; };
  $('#nav-close').onclick = () => setSetting('navpad', false);
  try { const pos = JSON.parse(localStorage.getItem('gsm.navpadPos') || 'null'); if (pos && pos.left) { pad.style.left = pos.left; pad.style.top = pos.top; pad.style.bottom = 'auto'; } } catch (_) {}
}
function refPoint() {
  if (state.estimate) return state.estimate.p.clone();
  if (state.rays.length) { const r = state.rays[0]; const t = Math.max(0.05 * (state.bounds?.radius || 1), controls.target.clone().sub(r.o).dot(r.d)); return r.o.clone().addScaledVector(r.d, t); }
  return null;
}

// ------------------------------------------------------------------ 투영/광선
const _v = new THREE.Vector3();
function project(p) {
  const { w, h } = viewSize(); _v.copy(p).project(camera);
  const front = _v.z < 1 && p.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) > 0;
  return { x: (_v.x + 1) / 2 * w, y: (1 - _v.y) / 2 * h, front };
}
const raycaster = new THREE.Raycaster();
function rayFromPixel(px, py) {
  const { w, h } = viewSize();
  raycaster.setFromCamera({ x: px / w * 2 - 1, y: -(py / h) * 2 + 1 }, camera);
  const o = raycaster.ray.origin.clone(), d = raycaster.ray.direction.clone().normalize();
  if (state.mesh) { // 메시 로컬(파일) 좌표로 변환 — 현재는 단위행렬이지만 안전을 위해
    const inv = state.mesh.matrixWorld.clone().invert(); o.applyMatrix4(inv); d.transformDirection(inv).normalize();
  }
  return { o, d, screen: { x: px, y: py }, camPos: camera.position.clone(), fovPx: focalPx() };
}
function focalPx() { const { h } = viewSize(); return (h / 2) / Math.tan(camera.fov / 2 * DEG); }
function epipolarPolyline(ray) {
  const R = state.bounds?.radius || 10; const pts = [];
  for (let i = 0; i < 120; i++) { const t = R * 0.005 * Math.pow(40 / 0.005, i / 119); pts.push(project(ray.o.clone().addScaledVector(ray.d, t))); }
  return pts;
}
function nearestOnPolyline(line, pt) {
  let best = { dist: Infinity, pt: null, i: -1 };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1]; if (!a.front || !b.front) continue;
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
    let s = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2; s = Math.max(0, Math.min(1, s));
    const q = { x: a.x + s * dx, y: a.y + s * dy }; const dd = Math.hypot(q.x - pt.x, q.y - pt.y);
    if (dd < best.dist) best = { dist: dd, pt: q, i, dir: { x: dx / Math.sqrt(L2), y: dy / Math.sqrt(L2) } };
  }
  return best;
}

// ------------------------------------------------------------------ 최소제곱 교회 (논문 식 3~8 과 동치)
function intersectRays(rays) {
  const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0); const b = new THREE.Vector3();
  const Ae = A.elements; // column-major
  for (const r of rays) {
    const d = r.d, o = r.o;
    const M = [1 - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, 1 - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, 1 - d.z * d.z]; // row-major
    for (let rI = 0; rI < 3; rI++) for (let c = 0; c < 3; c++) Ae[c * 3 + rI] += M[rI * 3 + c];
    b.x += M[0] * o.x + M[1] * o.y + M[2] * o.z; b.y += M[3] * o.x + M[4] * o.y + M[5] * o.z; b.z += M[6] * o.x + M[7] * o.y + M[8] * o.z;
  }
  const Ainv = A.clone(); if (Math.abs(A.determinant()) < 1e-12) return null; Ainv.invert();
  const p = b.clone().applyMatrix3(Ainv);
  let sse = 0; const residuals = [], pxResid = [];
  for (const r of rays) {
    const diff = p.clone().sub(r.o); const t = diff.dot(r.d); const perp = diff.clone().addScaledVector(r.d, -t); const len = perp.length();
    residuals.push(len); pxResid.push(t > 1e-9 ? len / t * r.fovPx : Infinity); sse += len * len;
  }
  const n = rays.length, dof = Math.max(1, 2 * n - 3); const sigma0 = Math.sqrt(sse / dof);
  const cov = Ainv.clone().multiplyScalar(sigma0 * sigma0);
  let maxAngle = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) maxAngle = Math.max(maxAngle, Math.acos(THREE.MathUtils.clamp(rays[i].d.dot(rays[j].d), -1, 1)));
  const finitePx = pxResid.filter(Number.isFinite); const pxRms = finitePx.length ? Math.sqrt(finitePx.reduce((s, v) => s + v * v, 0) / finitePx.length) : Infinity;
  const maxAngleDeg = maxAngle / DEG;
  const quality = (pxRms <= 1.5 && maxAngleDeg >= 20) ? 'good' : (pxRms <= 4 && maxAngleDeg >= 10) ? 'fair' : 'poor';
  return { p, sigma0, cov, residuals, pxResid, pxRms, maxAngleDeg, n, quality };
}
// ================================================================== 분석 1단계: 각도 · 수평/수직/경사 · 폴리라인 길이 · 면적
function upVec() { return camera.up.clone().normalize(); }
function jacobiSym(A) { // 대칭 n×n 고유분해 → { vals[], vecs[][] (vecs[k] = k번째 고유벡터) }
  const n = A.length; const a = A.map((r) => r.slice()); const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 80; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]; if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue; const th = (a[q][q] - a[p][p]) / (2 * a[p][q]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)); const c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s2 * akq; a[k][q] = s2 * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s2 * aqk; a[q][k] = s2 * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s2 * vkq; v[k][q] = s2 * vkp + c * vkq; }
    }
  }
  return { vals: a.map((r, i) => r[i]), vecs: Array.from({ length: n }, (_, k) => v.map((row) => row[k])) };
}
// 점 좌표의 함수 fn(x[]) 값과, 각 점 공분산을 수치 미분으로 전파한 표준편차
function propagate(fn, pts) {
  const x = pts.flatMap((p) => [p.p.x, p.p.y, p.p.z]); const v0 = fn(x); const h = 1e-6 * Math.max(1, state.bounds?.radius || 1); let variance = 0;
  for (let i = 0; i < pts.length; i++) {
    const J = [0, 0, 0]; for (let k = 0; k < 3; k++) { const xp = x.slice(), xm = x.slice(); xp[3 * i + k] += h; xm[3 * i + k] -= h; J[k] = (fn(xp) - fn(xm)) / (2 * h); }
    const c = pts[i].cov.elements; // column-major, 대칭
    variance += J[0] * (c[0] * J[0] + c[3] * J[1] + c[6] * J[2]) + J[1] * (c[1] * J[0] + c[4] * J[1] + c[7] * J[2]) + J[2] * (c[2] * J[0] + c[5] * J[1] + c[8] * J[2]);
  }
  return { v: v0, sigma: Math.sqrt(Math.max(0, variance)) };
}
const V3 = (x, i) => new THREE.Vector3(x[3 * i], x[3 * i + 1], x[3 * i + 2]);
function fnAngleDeg(x) { const u = V3(x, 0).sub(V3(x, 1)), w = V3(x, 2).sub(V3(x, 1)); const d = u.dot(w) / (u.length() * w.length() || 1e-12); return Math.acos(THREE.MathUtils.clamp(d, -1, 1)) / DEG; }
function fnPolyLen(closed) { return (x) => { const n = x.length / 3; let L = 0; for (let i = 0; i + 1 < n; i++) L += V3(x, i).distanceTo(V3(x, i + 1)); if (closed && n > 2) L += V3(x, n - 1).distanceTo(V3(x, 0)); return L; }; }
function planeFit(P) { // P: Vector3[] → { c, n(단위 법선), e1, e2, rms }
  const c = new THREE.Vector3(); P.forEach((p) => c.add(p)); c.divideScalar(P.length);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const p of P) { const d = [p.x - c.x, p.y - c.y, p.z - c.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j]; }
  const { vals, vecs } = jacobiSym(M); const order = [0, 1, 2].sort((a, b) => vals[a] - vals[b]);
  const n = new THREE.Vector3(...vecs[order[0]]).normalize(), e1 = new THREE.Vector3(...vecs[order[2]]).normalize(); const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
  let ss = 0; for (const p of P) { const r = p.clone().sub(c).dot(n); ss += r * r; } return { c, n, e1, e2, rms: Math.sqrt(ss / P.length) };
}
function shoelace(pts2) { let a = 0; for (let i = 0; i < pts2.length; i++) { const p = pts2[i], q = pts2[(i + 1) % pts2.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
function fnArea(x) { const n = x.length / 3; const P = Array.from({ length: n }, (_, i) => V3(x, i)); const pf = planeFit(P); return shoelace(P.map((p) => { const d = p.clone().sub(pf.c); return [d.dot(pf.e1), d.dot(pf.e2)]; })); }
function fnAreaHoriz(x) { const n = x.length / 3; const up = upVec(); let h = new THREE.Vector3(1, 0, 0); if (Math.abs(h.dot(up)) > 0.9) h.set(0, 1, 0); h.projectOnPlane(up).normalize(); const h2 = new THREE.Vector3().crossVectors(up, h); return shoelace(Array.from({ length: n }, (_, i) => { const p = V3(x, i); return [p.dot(h), p.dot(h2)]; })); }
function distanceDecomp(a, b) { // 3D 거리 + 수평·고저차·경사
  const up = upVec(); const di = distanceInfo(a, b);
  const fh = (x) => { const d = V3(x, 1).sub(V3(x, 0)); return d.clone().sub(up.clone().multiplyScalar(d.dot(up))).length(); };
  const fv = (x) => V3(x, 1).sub(V3(x, 0)).dot(up);
  const H = propagate(fh, [a, b]), V = propagate(fv, [a, b]);
  const slopeDeg = Math.atan2(Math.abs(V.v), H.v) / DEG, slopePct = H.v > 1e-9 ? Math.abs(V.v) / H.v * 100 : Infinity;
  return { ...di, h: H.v, sigmaH: H.sigma, v: V.v, sigmaV: V.sigma, slopeDeg, slopePct };
}
function geomInfo(g) { // 저장된 분석 항목의 값 계산 (점이 지워졌으면 null)
  const pts = g.ptIds.map((id) => state.points.find((p) => p.id === id)); if (pts.some((p) => !p)) return null;
  if (g.type === 'angle') { const r = propagate(fnAngleDeg, pts); return { pts, main: r.v, sigma: r.sigma, text: `${r.v.toFixed(2)}° ± ${r.sigma.toFixed(2)}°`, extra: `꼭짓점 ${pts[1].name}` }; }
  if (g.type === 'polyline') { const r = propagate(fnPolyLen(false), pts); return { pts, main: r.v, sigma: r.sigma, text: fmtLen(r.v, r.sigma, true), extra: `${pts.length}점 · 구간 ${pts.length - 1}` }; }
  if (g.type === 'area') {
    const A = propagate(fnArea, pts), Ah = propagate(fnAreaHoriz, pts), per = propagate(fnPolyLen(true), pts); const pf = planeFit(pts.map((p) => p.p));
    let tilt = Math.acos(THREE.MathUtils.clamp(Math.abs(pf.n.dot(upVec())), 0, 1)) / DEG;
    return { pts, main: A.v, sigma: A.sigma, text: fmtArea(A.v, A.sigma), extra: `수평투영 ${fmtArea(Ah.v)} · 둘레 ${fmtLen(per.v, per.sigma, true)} · 면 기울기 ${tilt.toFixed(1)}° · 평면 잔차 RMS ${fmtLen(pf.rms)}`, tilt, per: per.v, ah: Ah.v, rms: pf.rms };
  }
  return null;
}
function fmtArea(aModel, sig = null) {
  if (!state.unit.known) return `${aModel.toFixed(4)} u²${sig != null ? ` ± ${sig.toFixed(4)}` : ''}`;
  const f2 = state.unit.factor * state.unit.factor; let a = aModel * f2, sg = sig != null ? Math.sqrt((sig * f2) ** 2 + (2 * a * state.unit.sigmaRel) ** 2) : null;
  const cm = a < 1; const k = cm ? 1e4 : 1, dec = cm ? 1 : 3; return `${(a * k).toFixed(dec)}${sg != null ? ` ± ${(sg * k).toFixed(dec)}` : ''} ${cm ? 'cm²' : 'm²'}`;
}
const GEOM_NEED = { angle: 3, polyline: 2, area: 3 }; const GEOM_LABEL = { angle: '∠ 각도', polyline: '⌒ 길이', area: '▱ 면적' };
function addGeom(type, pts) { const g = { id: state.nextGeomId++, type, name: `${type === 'angle' ? 'A' : type === 'polyline' ? 'L' : 'S'}${state.nextGeomId - 1}`, ptIds: pts.map((p) => p.id) }; state.geoms.push(g); const gi = geomInfo(g); toast(`<b>${GEOM_LABEL[type]} ${g.name}</b> = <span style="font-size:17px">${gi.text}</span><br><span class="muted small">${gi.extra}</span>${state.unit.known || type === 'angle' ? '' : ' <span class="muted">(모델 단위 — 축척 보정 필요)</span>'}`, 'good', 9000); renderResults(); return g; }
function finishGeometry() {
  const t = state.task; if (!t || !GEOM_NEED[t.kind]) return;
  if (state.rays.length) { toast('먼저 진행 중인 점을 확정(Enter)하거나 취소(Esc)하세요.', 'warn', 3000); return; }
  if (t.pts.length < GEOM_NEED[t.kind]) { toast(`${GEOM_LABEL[t.kind]}에는 점이 ${GEOM_NEED[t.kind]}개 이상 필요합니다 (현재 ${t.pts.length}개).`, 'warn', 3500); return; }
  addGeom(t.kind, t.pts); endTask();
}
// 작업에 점이 추가된 뒤 (새 측정 또는 기존 점 재사용) 종류별 처리
function taskPointAdded(t) {
  if (t.kind === 'point') { updateMeasureUI(); }
  else if (t.kind === 'distance') { if (t.pts.length === 2) { addDistance(t.pts[0], t.pts[1]); endTask(); } else updateMeasureUI(); }
  else if (t.kind === 'calib') { if (t.pts.length === 2) { const di = distanceInfo(t.pts[0], t.pts[1]); endTask(); openCalibResult(t, di); } else updateMeasureUI(); }
  else if (t.kind === 'angle') { if (t.pts.length === 3) { addGeom('angle', t.pts); endTask(); } else updateMeasureUI(); }
  else updateMeasureUI();
}
function pickExistingPoint(px, py) { let best = null, bd = 14; for (const p of state.points) { const s = project(p.p); if (!s.front) continue; const d = Math.hypot(s.x - px, s.y - py); if (d < bd) { bd = d; best = p; } } return best; }
function distanceInfo(a, b) {
  const v = b.p.clone().sub(a.p); const d = v.length(); if (d < 1e-12) return { d: 0, sigma: 0 };
  const u = v.clone().divideScalar(d); const Q = a.cov.clone(); const be = b.cov.elements; for (let i = 0; i < 9; i++) Q.elements[i] += be[i];
  const Qu = u.clone().applyMatrix3(Q); const varD = Math.max(0, u.dot(Qu));
  return { d, sigma: Math.sqrt(varD) };
}

// ------------------------------------------------------------------ 단위/포맷
function toMeters(v) { return v * state.unit.factor; }
function fmtLen(vModel, sigModel = null, dist = false) {
  if (!state.unit.known) return `${vModel.toFixed(3)} u${sigModel != null ? ` ± ${sigModel.toFixed(3)}` : ''}`;
  const m = toMeters(vModel); let s = sigModel != null ? toMeters(sigModel) : null;
  if (s != null && dist && state.unit.sigmaRel) s = Math.sqrt(s * s + (m * state.unit.sigmaRel) ** 2);
  let unit = state.settings.dunit; if (unit === 'auto') unit = Math.abs(m) >= 1 ? 'm' : 'cm';
  const k = unit === 'm' ? 1 : unit === 'cm' ? 100 : 1000; const dec = unit === 'm' ? 3 : unit === 'cm' ? 1 : 0;
  return `${(m * k).toFixed(dec)}${s != null ? ` ± ${(s * k).toFixed(dec)}` : ''} ${unit}`;
}
function toReal(p) { const T = state.unit.transform; if (!T) return null; const R = T.R, s = T.s; return new THREE.Vector3(s * (R[0] * p.x + R[1] * p.y + R[2] * p.z) + T.t[0], s * (R[3] * p.x + R[4] * p.y + R[5] * p.z) + T.t[1], s * (R[6] * p.x + R[7] * p.y + R[8] * p.z) + T.t[2]); }
function fmtCoord(p) { const r = toReal(origCoord(p)); if (r) return `(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}) m ${state.unit.crs ? '· ' + state.unit.crs : ''}`; const f = state.unit.known ? state.unit.factor : 1; const u = state.unit.known ? 'm' : 'u'; const q = origCoord(p); return `(${(q.x * f).toFixed(3)}, ${(q.y * f).toFixed(3)}, ${(q.z * f).toFixed(3)}) ${u}`; }

// ------------------------------------------------------------------ 알림
function showError(code, extra = '', opts = {}) {
  const e = ERRORS[code]; if (!e) return;
  const t = document.createElement('div'); t.className = `toast ${e.level}`;
  t.innerHTML = `<span class="code">${code} · ${e.level === 'block' ? '진행 불가' : e.level === 'warn' ? '주의' : '안내'} <button class="xbtn" title="닫기">✕</button></span><b>${e.title}</b><div class="why">${e.why}${extra ? `<br>${extra}` : ''}</div><div class="fix">👉 ${e.fix}</div>${opts.actions || ''}`;
  t.querySelector('.xbtn').onclick = () => t.remove();
  if (opts.onAction) t.addEventListener('click', (ev) => { const a = ev.target.closest('[data-act]'); if (a) { opts.onAction(a.dataset.act); t.remove(); } });
  $('#toasts').appendChild(t);
  const ttl = e.level === 'block' ? 0 : e.level === 'warn' ? 14000 : 8000; if (ttl) setTimeout(() => t.remove(), ttl);
  updateCheckDot();
  return t;
}
function toast(html, kind = 'info', ms = 5000) { const t = document.createElement('div'); t.className = `toast ${kind}`; t.innerHTML = html; $('#toasts').appendChild(t); if (ms) setTimeout(() => t.remove(), ms); return t; }
function coach(step, text, right = '') { $('#coach-step').textContent = step || ''; $('#coach-text').innerHTML = text; $('#coach-right').textContent = right; }

// ------------------------------------------------------------------ PLY 헤더 해석
function parsePlyHeader(buf) {
  const n = Math.min(buf.byteLength, 300000); const bytes = new Uint8Array(buf, 0, n);
  let text = ''; for (let i = 0; i < n; i++) text += String.fromCharCode(bytes[i]);
  const idx = text.indexOf('end_header'); if (!text.startsWith('ply') || idx < 0) return null;
  const lines = text.slice(0, idx).split(/\r?\n/); const h = { format: '', elements: {}, order: [], comments: [], headerLength: idx + 'end_header'.length + 1 };
  let cur = null;
  for (const raw of lines) {
    const L = raw.trim(); if (!L) continue; const p = L.split(/\s+/);
    if (p[0] === 'format') h.format = p[1];
    else if (p[0] === 'comment' || p[0] === 'obj_info') h.comments.push(L.replace(/^(comment|obj_info)\s*/, ''));
    else if (p[0] === 'element') { cur = { name: p[1], count: parseInt(p[2], 10), props: [] }; h.elements[p[1]] = cur; h.order.push(p[1]); }
    else if (p[0] === 'property' && cur) { if (p[1] === 'list') cur.props.push({ name: p[4], type: 'list' }); else cur.props.push({ name: p[2], type: p[1] }); }
  }
  const v = h.elements.vertex; const names = v ? v.props.map((q) => q.name) : [];
  h.compressed = !!(h.elements.chunk && names.some((q) => /packed_/.test(q)));
  h.has3dgs = h.compressed || (names.includes('opacity') && names.includes('rot_0') && names.includes('scale_0'));
  h.is2dgs = !h.compressed && names.includes('scale_1') && !names.includes('scale_2') && names.includes('opacity');
  h.count = v ? v.count : 0; h.names = names;
  const shRest = names.filter((q) => q.startsWith('f_rest_')).length; h.shDegree = shRest ? Math.round(Math.sqrt(shRest / 3 + 1) - 1) : 0;
  const ctext = h.comments.join('\n').toLowerCase();
  h.unitsMeters = /\bunits?\s*[:=]?\s*(m|meters?|metres?)\b/.test(ctext);
  const sm = ctext.match(/scale_to_meters\s*[:=]\s*([0-9.eE+-]+)/); h.scaleToMeters = sm ? parseFloat(sm[1]) : null;
  const um = ctext.match(/up[\s_-]?axis\s*[:=]?\s*([+-]?)([xyz])/); h.upAxis = um ? (um[1] || '+') + um[2] : null;
  return h;
}
// ================================================================== 점군 보기 · 1클릭 직접 선택
const SH_C0 = 0.28209479177387814;
function buildCloudFromPly(buf, h) { // 3DGS PLY → {pos Float32Array(N*3), col Uint8Array(N*3, sRGB), rad Float32Array(N, 가우시안 반경), n}
  if (!h || h.compressed || h.format !== 'binary_little_endian' || h.order[0] !== 'vertex') return null;
  const v = h.elements.vertex; if (v.props.some((q) => q.type !== 'float' && q.type !== 'float32')) return null;
  const k = v.props.length, ix = h.names.indexOf('x'), ir = h.names.indexOf('f_dc_0'), io = h.names.indexOf('opacity'), is0 = h.names.indexOf('scale_0'); if (ix < 0) return null;
  const aligned = h.headerLength % 4 === 0; const f32 = aligned ? new Float32Array(buf, h.headerLength, v.count * k) : new Float32Array(buf.slice(h.headerLength, h.headerLength + v.count * k * 4));
  const iq = h.names.indexOf('rot_0'); const pos = new Float32Array(v.count * 3), col = new Uint8Array(v.count * 3), rad = new Float32Array(v.count), scl = new Float32Array(v.count * 3), quat = new Float32Array(v.count * 4); let n = 0;
  for (let i = 0; i < v.count; i++) { const b = i * k; if (io >= 0 && 1 / (1 + Math.exp(-f32[b + io])) < 0.05) continue; pos[3 * n] = f32[b + ix]; pos[3 * n + 1] = f32[b + ix + 1]; pos[3 * n + 2] = f32[b + ix + 2];
    if (ir >= 0) for (let c = 0; c < 3; c++) col[3 * n + c] = Math.max(0, Math.min(255, Math.round((0.5 + SH_C0 * f32[b + ir + c]) * 255))); else col[3 * n] = col[3 * n + 1] = col[3 * n + 2] = 200;
    if (is0 >= 0) { const a = Math.exp(f32[b + is0]), b2 = Math.exp(f32[b + is0 + 1]), c2 = h.names.includes('scale_2') ? Math.exp(f32[b + is0 + 2]) : Math.min(a, b2); const srt = [a, b2, c2].sort((x, y) => y - x); rad[n] = Math.sqrt(srt[0] * srt[1]); scl[3 * n] = a; scl[3 * n + 1] = b2; scl[3 * n + 2] = c2; } else { rad[n] = 0; scl[3 * n] = scl[3 * n + 1] = scl[3 * n + 2] = 0; }
    if (iq >= 0) { const qw = f32[b + iq], qx = f32[b + iq + 1], qy = f32[b + iq + 2], qz = f32[b + iq + 3]; const L = Math.hypot(qw, qx, qy, qz) || 1; quat[4 * n] = qw / L; quat[4 * n + 1] = qx / L; quat[4 * n + 2] = qy / L; quat[4 * n + 3] = qz / L; } else { quat[4 * n] = 1; } n++; }
  return { pos: pos.subarray(0, n * 3), col: col.subarray(0, n * 3), rad: rad.subarray(0, n), scl: scl.subarray(0, n * 3), quat: quat.subarray(0, n * 4), n };
}
function buildCloudFromMesh(mesh) { try { const src = mesh.splats || mesh.packedSplats; const N = src?.numSplats || 0; if (!N || !src.forEachSplat) return null; const pos = new Float32Array(N * 3), col = new Uint8Array(N * 3), rad = new Float32Array(N), scl = new Float32Array(N * 3), quat = new Float32Array(N * 4); let n = 0; src.forEachSplat((i, c, sc, q, op, color) => { if (op < 0.05) return; pos[3 * n] = c.x; pos[3 * n + 1] = c.y; pos[3 * n + 2] = c.z; col[3 * n] = Math.round(color.r * 255); col[3 * n + 1] = Math.round(color.g * 255); col[3 * n + 2] = Math.round(color.b * 255); const srt = [sc.x, sc.y, sc.z].sort((x, y) => y - x); rad[n] = Math.sqrt(srt[0] * srt[1]); scl[3 * n] = sc.x; scl[3 * n + 1] = sc.y; scl[3 * n + 2] = sc.z; quat[4 * n] = q.w; quat[4 * n + 1] = q.x; quat[4 * n + 2] = q.y; quat[4 * n + 3] = q.z; n++; }); return { pos: pos.subarray(0, n * 3), col: col.subarray(0, n * 3), rad: rad.subarray(0, n), scl: scl.subarray(0, n * 3), quat: quat.subarray(0, n * 4), n }; } catch (e) { console.warn('점군 추출 실패', e); return null; } }
function cloudColors(cl) { const m = state.settings.cloudColor; const out = new Uint8Array(cl.n * 3); if (m === 'rgb') return cl.col;
  if (m === 'mono') { out.fill(190); return out; }
  const up = upVec(); let lo = Infinity, hi = -Infinity; const hs = new Float32Array(cl.n); for (let i = 0; i < cl.n; i++) { const hgt = cl.pos[3 * i] * up.x + cl.pos[3 * i + 1] * up.y + cl.pos[3 * i + 2] * up.z; hs[i] = hgt; }
  const sorted = Float32Array.from(hs).sort(); lo = sorted[Math.floor(cl.n * 0.02)]; hi = sorted[Math.floor(cl.n * 0.98)];
  for (let i = 0; i < cl.n; i++) { const t = THREE.MathUtils.clamp((hs[i] - lo) / Math.max(1e-9, hi - lo), 0, 1); const c = new THREE.Color().setHSL(0.7 - 0.7 * t, 0.9, 0.5); out[3 * i] = c.r * 255; out[3 * i + 1] = c.g * 255; out[3 * i + 2] = c.b * 255; } return out; }
const CLOUD_VS = `
attribute float rad; varying vec3 vColor;
uniform float uFocal; uniform float uMode; uniform float uPx; uniform float uScale; uniform float uMinPx; uniform float uMaxPx; uniform float uHideBig; uniform float uBigRad;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = uPx;
  if (uMode > 0.5) { px = 2.0 * rad * uScale * uFocal / max(-mv.z, 1e-4); px = clamp(px, uMinPx, uMaxPx); }
  if (uHideBig > 0.5 && rad > uBigRad) { px = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // 가장 큰 가우시안(잡티·하늘) 숨김
  gl_PointSize = px; gl_Position = projectionMatrix * mv;
}`;
const CLOUD_FS = `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard;
  vec3 lin = pow(vColor, vec3(2.2)); // 파일 색은 sRGB → 선형으로 바꾼 뒤 출력 색공간으로 인코딩 (안 하면 색이 바램)
  gl_FragColor = vec4(lin, 1.0);
  #include <colorspace_fragment>
}`;
function cloudUniforms(m) { const st = state.settings; const dpr = Math.min(window.devicePixelRatio || 1, 2); m.uniforms.uFocal.value = focalPx() * dpr; m.uniforms.uMode.value = st.ptMode === 'gauss' ? 1 : 0; m.uniforms.uPx.value = st.ptSize * dpr; m.uniforms.uScale.value = st.ptScale; m.uniforms.uMinPx.value = Math.max(1, st.ptSize * 0.5) * dpr; m.uniforms.uMaxPx.value = Math.max(1, st.ptMaxPx || 6) * dpr; m.uniforms.uHideBig.value = st.hideBig && st.ptMode !== 'dense' ? 1 : 0; m.uniforms.uBigRad.value = state.cloud?.bigRad ?? 1e30; }
const DENSE_MAX_POINTS = 20e6; // 총 표시 점 상한 (≈ 300 MB)
function densifyFactor(cl) { const st = state.settings; if (st.ptMode !== 'dense') return 1; const auto = Math.max(1, Math.min(10, Math.floor(DENSE_MAX_POINTS / Math.max(1, cl.n)))); if (st.densify === 'auto') return auto; return Math.max(1, Math.min(auto, +st.densify || 1)); }
// 각 가우시안의 3D 분포 N(μ, R S² Rᵀ) 에서 K개 표본을 뽑아 조밀한 점군을 만든다 (표시 전용; 직접 선택은 중심점 기준)
function buildDenseSamples(cl, K, colors) {
  const hide = state.settings.hideBig && cl.bigRad != null ? cl.bigRad : Infinity; const spread = 0.8; // ≈ 0.8σ → 스플랫 시각 두께와 비슷
  let keep = 0; for (let i = 0; i < cl.n; i++) if (cl.rad[i] <= hide) keep++;
  const M = keep * K; const pos = new Float32Array(M * 3), col = new Uint8Array(M * 3);
  let seed = 123456789; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  let m = 0; for (let i = 0; i < cl.n; i++) {
    if (cl.rad[i] > hide) continue;
    const cx = cl.pos[3 * i], cy = cl.pos[3 * i + 1], cz = cl.pos[3 * i + 2]; const sx = cl.scl[3 * i] * spread, sy = cl.scl[3 * i + 1] * spread, sz = cl.scl[3 * i + 2] * spread;
    const qw = cl.quat[4 * i], qx = cl.quat[4 * i + 1], qy = cl.quat[4 * i + 2], qz = cl.quat[4 * i + 3];
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw), r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw), r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
    const c0 = colors[3 * i], c1 = colors[3 * i + 1], c2 = colors[3 * i + 2];
    for (let k = 0; k < K; k++) {
      let gx = 0, gy = 0, gz = 0; if (k > 0) { const u1 = Math.max(rnd(), 1e-9), u2 = rnd(), u3 = Math.max(rnd(), 1e-9), u4 = rnd(); const rr = Math.sqrt(-2 * Math.log(u1)), r2 = Math.sqrt(-2 * Math.log(u3)); gx = rr * Math.cos(6.283185307 * u2); gy = rr * Math.sin(6.283185307 * u2); gz = r2 * Math.cos(6.283185307 * u4); }
      const lx = gx * sx, ly = gy * sy, lz = gz * sz;
      pos[3 * m] = cx + r00 * lx + r01 * ly + r02 * lz; pos[3 * m + 1] = cy + r10 * lx + r11 * ly + r12 * lz; pos[3 * m + 2] = cz + r20 * lx + r21 * ly + r22 * lz;
      col[3 * m] = c0; col[3 * m + 1] = c1; col[3 * m + 2] = c2; m++;
    }
  }
  return { pos, col, n: M };
}
function updateDenseLabel() { const el = $('#q-dense-info'); if (!el) return; const cl = state.cloud; if (!cl) { el.textContent = ''; return; } const di = state.denseInfo; el.textContent = di ? `표시 ${di.total.toLocaleString()}점 = 가우시안 ${cl.n.toLocaleString()} × ${di.K} (생성 ${di.ms} ms, 약 ${di.mb} MB)` : `표시 ${cl.n.toLocaleString()}점 (가우시안 중심)`; }
function rebuildPoints() {
  if (state.points3) { scene.remove(state.points3); state.points3.geometry.dispose(); state.points3.material.dispose(); state.points3 = null; }
  const cl = state.cloud; if (!cl) return;
  if (cl.rad && cl.bigRad == null) { const sorted = Float32Array.from(cl.rad).sort(); cl.bigRad = sorted[Math.floor(cl.n * 0.99)]; } // 반경 상위 1 % 기준값
  const colors = cloudColors(cl); const K = densifyFactor(cl); let src = cl, srcCol = colors, isDense = false;
  if (state.settings.ptMode === 'dense' && cl.scl && cl.quat) { const t0 = performance.now(); const d = buildDenseSamples(cl, K, colors); src = d; srcCol = d.col; isDense = true; state.denseInfo = { K, total: d.n, ms: Math.round(performance.now() - t0), mb: +(d.n * 15 / 1e6).toFixed(0) }; } else state.denseInfo = null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(src.pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(srcCol, 3, true)); g.setAttribute('rad', new THREE.BufferAttribute(isDense ? new Float32Array(src.n) : (cl.rad || new Float32Array(cl.n)), 1));
  const m = new THREE.ShaderMaterial({ vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, vertexColors: true, uniforms: { uFocal: { value: 1000 }, uMode: { value: 1 }, uPx: { value: 2 }, uScale: { value: 1 }, uMinPx: { value: 1 }, uMaxPx: { value: 24 }, uHideBig: { value: 1 }, uBigRad: { value: 1e30 } }, depthTest: true, depthWrite: true });
  cloudUniforms(m); updateDenseLabel();
  state.points3 = new THREE.Points(g, m); state.points3.frustumCulled = false; state.points3.onBeforeRender = () => cloudUniforms(m); scene.add(state.points3); applyViewMode();
}
function applyViewMode() {
  const mode = state.settings.viewMode; const names = { splat: '스플랫', cloud: '점군', both: '겹침' };
  if (state.mesh) state.mesh.visible = mode !== 'cloud' || !state.points3;
  if (state.points3) state.points3.visible = mode !== 'splat';
  $('#view-label').textContent = names[mode] || mode; $('#cloud-quick').hidden = !(mode !== 'splat' && state.points3); $$('#menu-view button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  if (mode !== 'splat' && !state.points3 && state.mesh) toast('이 파일에서는 점군을 만들 수 없어 스플랫으로 표시합니다.', 'warn', 4000);
}
function directPickEnabled() { return state.settings.viewMode !== 'splat' ? !!state.cloud : (state.settings.pickSplat && !!state.cloud); }
// 클릭 광선 원뿔 안의 가우시안 중심에서 점 하나를 고른다 → { p, sigma, n, mode } | null
function directPick(px, py) {
  const cl = state.cloud; if (!cl) return null;
  const ray = rayFromPixel(px, py); const o = ray.o, d = ray.d; const f = focalPx();
  for (let rad = state.settings.pickRadius; rad <= 40; rad *= 2) {
    const tanA = rad / f; const hits = [];
    for (let i = 0; i < cl.n; i++) { const vx = cl.pos[3 * i] - o.x, vy = cl.pos[3 * i + 1] - o.y, vz = cl.pos[3 * i + 2] - o.z; const t = vx * d.x + vy * d.y + vz * d.z; if (t <= 1e-6) continue; const perp2 = vx * vx + vy * vy + vz * vz - t * t; const lim = t * tanA; if (perp2 < lim * lim) hits.push({ t, i, ang: Math.sqrt(Math.max(0, perp2)) / t }); }
    if (!hits.length) continue;
    if (state.settings.pickMode === 'nearest') { let b = hits[0]; for (const h of hits) if (h.ang < b.ang) b = h; return { p: new THREE.Vector3(cl.pos[3 * b.i], cl.pos[3 * b.i + 1], cl.pos[3 * b.i + 2]), sigma: 0, n: 1, mode: 'nearest', radius: rad }; }
    hits.sort((a, b) => a.t - b.t); const K = Math.max(3, Math.floor(hits.length * 0.03)); let s0 = -1;
    for (let a = 0; a + K - 1 < hits.length; a++) { if (hits[a + K - 1].t <= hits[a].t * 1.12) { s0 = a; break; } }
    if (s0 < 0) { if (hits.length < 3) { const b = hits[0]; return { p: new THREE.Vector3(cl.pos[3 * b.i], cl.pos[3 * b.i + 1], cl.pos[3 * b.i + 2]), sigma: 0, n: 1, mode: 'cluster(단일)', radius: rad }; } s0 = 0; }
    const tEnd = hits[s0].t * 1.12; const mem = hits.filter((h, idx) => idx >= s0 && h.t <= tEnd);
    const xs = mem.map((h) => cl.pos[3 * h.i]), ys = mem.map((h) => cl.pos[3 * h.i + 1]), zs = mem.map((h) => cl.pos[3 * h.i + 2]); const med = (arr) => { const a2 = Float64Array.from(arr).sort(); return a2[Math.floor(a2.length / 2)]; };
    const p = new THREE.Vector3(med(xs), med(ys), med(zs)); let ss = 0; for (const h of mem) ss += (cl.pos[3 * h.i] - p.x) ** 2 + (cl.pos[3 * h.i + 1] - p.y) ** 2 + (cl.pos[3 * h.i + 2] - p.z) ** 2;
    return { p, sigma: Math.sqrt(ss / mem.length / 3), n: mem.length, mode: 'cluster', radius: rad };
  }
  return null;
}
function openPickHelp() {
  openModal(`<h2>1클릭 직접 선택 — 두 방식의 차이</h2>
  <p class="small">3DGS의 가우시안은 표면 위의 점이 아니라 <b>표면 근처에 두께를 가지고 흩어진 타원</b>들입니다. 한 표면의 중심점들은 보통 수 cm~수십 cm 두께로 퍼져 있고 앞뒤에 반투명 잡티(floater)가 떠 있습니다. 그래서 "어느 점을 좌표로 삼느냐"에 따라 결과가 달라집니다. 이 방식은 논문이 다시점 방법보다 부정확하다고 지적한 "점군/메시 직접 찍기"에 해당하므로, 빠른 측정용으로 쓰고 정밀도가 필요하면 <b>[정밀화]</b>(다시점 클릭)로 이어가세요.</p>
  <table class="cmp"><tr><th>상황</th><th>가장 가까운 점 하나</th><th>앞쪽 군집 중앙값 (권장·기본)</th></tr>
  <tr><td>평평한 벽·바닥</td><td>표면 앞뒤로 튄 점 하나가 걸려 오차가 스플랫 두께만큼 무작위로 생김</td><td>여러 점의 중앙값이라 흩어짐이 평균되어 안정적</td></tr>
  <tr><td>앞에 잡티가 떠 있음</td><td>잡티를 그대로 찍음(수 m 튈 수 있음)</td><td>1~2개짜리 외톨이는 무시하고 뒤의 진짜 표면 무리를 택함</td></tr>
  <tr><td>가는 기둥·모서리·표지판 끝</td><td>커서가 정확하면 그 점을 찍어 <b>뾰족한 특징점에 유리</b></td><td>원뿔 안에 배경 점이 섞이면 중앙값이 뒤로 끌릴 수 있음 → 원뿔 반경을 작게</td></tr>
  <tr><td>재현성(같은 곳 두 번 클릭)</td><td>커서 1 px 차이로 다른 점이 잡혀 값이 흔들림</td><td>거의 같은 값</td></tr>
  <tr><td>불확도(σ) 표시</td><td>점 하나라 알 수 없음(0으로 표시)</td><td>군집의 퍼짐을 σ로 표시</td></tr></table>
  <p class="small"><b>권장</b>: 기본은 군집 중앙값, 뾰족한 특징점을 찍을 때만 "가장 가까운 점 하나"로 바꾸고, 가는 구조물에서는 커서 원뿔 반경을 3~5 px 로 줄이세요. 어느 쪽이든 결과에는 <span class="badge pick">직접선택</span> 배지가 붙습니다. 측정 중 <b>Shift+클릭</b>은 항상 다시점 광선(정밀)입니다.</p>
  <div class="btnrow"><button class="btn primary" id="pick-help-ok">알겠습니다</button><button class="btn" id="pick-help-set">설정에서 방식 바꾸기</button></div>`);
  $('#pick-help-ok').onclick = closeModal; $('#pick-help-set').onclick = () => { closeModal(); showTab('settings'); };
}
// 직접 선택한 점을 작업에 추가
function addPickedPoint(px, py) {
  const r = directPick(px, py); if (!r) { toast('커서 아래에서 점군 점을 찾지 못했습니다. 모델 위를 클릭하거나 원뿔 반경을 키우세요.', 'warn', 3500); return false; }
  const pt = { id: state.nextId++, name: `P${state.nextId - 1}`, p: r.p, sigma0: r.sigma, cov: new THREE.Matrix3().identity().multiplyScalar(Math.max(r.sigma, 1e-4) ** 2), n: r.n, quality: 'pick', method: 'pick', pickMode: r.mode, pxRms: NaN, maxAngleDeg: 0, rays: [] };
  state.points.push(pt); const t = state.task; t.pts.push(pt);
  toast(`<b>${pt.name} 직접 선택</b> ${fmtCoord(pt.p)} · 군집 ${r.n}점 · σ ${fmtLen(r.sigma)} <span class="badge pick">직접선택</span><br><span class="muted small">방식: ${r.mode === 'nearest' ? '가장 가까운 점 하나' : '앞쪽 군집 중앙값'} · 정밀도가 필요하면 결과 표의 [정밀화]</span>`, 'info', 6000);
  if (!state.settings.pickHelpSeen) { setSetting('pickHelpSeen', true); openPickHelp(); }
  taskPointAdded(t); renderResults(); updateCheckDot(); return true;
}
function startRefine(id) { const pt = state.points.find((q) => q.id === id); if (!pt) return; startTask('point', { refineId: id }); state.autoPivot = pt.p.clone(); moveTarget(pt.p, 300); toast(`<b>${pt.name} 정밀화</b> — 같은 점을 여러 각도에서 ${state.settings.n}회 클릭하면 다시점 결과로 교체됩니다 (자동 회전이 이 점을 중심으로 돕니다).`, 'info', 7000); }
const PLY_TYPE_SIZE = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
// 좌표가 매우 큰 PLY(지역·국가 좌표계)의 x,y,z 에서 오프셋을 빼 원점 근처로 옮긴다(버퍼 제자리 수정). 압축 PLY 는 chunk 의 min/max 를 옮긴다.
function shiftPlyInPlace(buf, h, off) {
  if (h.format !== 'binary_little_endian') return false;
  const dv = new DataView(buf); let pos = h.headerLength; let done = false;
  for (const name of h.order) {
    const el = h.elements[name]; if (el.props.some((q) => q.type === 'list')) return done; // list 속성은 길이를 알 수 없음
    const sizes = el.props.map((q) => PLY_TYPE_SIZE[q.type] || 0); if (sizes.some((z) => !z)) return done;
    const stride = sizes.reduce((a, b) => a + b, 0); const offs = []; let o = 0; for (const z of sizes) { offs.push(o); o += z; }
    const idx = (nm) => { const i = el.props.findIndex((q) => q.name === nm); return i >= 0 && (el.props[i].type === 'float' || el.props[i].type === 'float32') ? offs[i] : -1; };
    const keys = name === 'vertex' ? [['x', 0], ['y', 1], ['z', 2]] : name === 'chunk' ? [['min_x', 0], ['min_y', 1], ['min_z', 2], ['max_x', 0], ['max_y', 1], ['max_z', 2]] : [];
    const cols = keys.map(([nm, ax]) => [idx(nm), ax]).filter(([i]) => i >= 0);
    if (cols.length) { for (let v = 0; v < el.count; v++) { const base = pos + v * stride; if (base + stride > buf.byteLength) break; for (const [ci, ax] of cols) dv.setFloat32(base + ci, dv.getFloat32(base + ci, true) - off[ax], true); } done = true; }
    pos += el.count * stride;
  }
  return done;
}
function origCoord(p) { const o = state.coordOffset; return o ? new THREE.Vector3(p.x + o[0], p.y + o[1], p.z + o[2]) : p.clone(); } // 뷰어 내부 좌표 → 파일 원래 좌표
function positionsFromPly(buf, h) {
  if (!h || h.compressed || h.format !== 'binary_little_endian' || h.order[0] !== 'vertex') return null;
  const v = h.elements.vertex; if (v.props.some((p) => p.type !== 'float' && p.type !== 'float32')) return null;
  const stride = v.props.length * 4; const ix = h.names.indexOf('x'), iy = h.names.indexOf('y'), iz = h.names.indexOf('z'); if (ix < 0) return null;
  const dv = new DataView(buf, h.headerLength); const step = Math.max(1, Math.floor(v.count / 200000)); const out = [];
  for (let i = 0; i < v.count; i += step) { const o = i * stride; if (o + stride > dv.byteLength) break; out.push(dv.getFloat32(o + ix * 4, true), dv.getFloat32(o + iy * 4, true), dv.getFloat32(o + iz * 4, true)); }
  return out;
}
function boundsFromPositions(arr) {
  const n = arr.length / 3; if (n < 3) return { center: new THREE.Vector3(), radius: 5 };
  const xs = [], ys = [], zs = []; for (let i = 0; i < n; i++) { xs.push(arr[3 * i]); ys.push(arr[3 * i + 1]); zs.push(arr[3 * i + 2]); }
  const med = (a) => { const s = Float64Array.from(a).sort(); return s[Math.floor(s.length / 2)]; };
  const c = new THREE.Vector3(med(xs), med(ys), med(zs));
  const d = new Float64Array(n); for (let i = 0; i < n; i++) d[i] = Math.hypot(xs[i] - c.x, ys[i] - c.y, zs[i] - c.z);
  d.sort(); const radius = Math.max(1e-3, d[Math.floor(n * 0.75)]); // 75 퍼센타일: 멀리 떠 있는 배경 잡티(floater)에 프레이밍이 휘둘리지 않게
  return { center: c, radius };
}

// ------------------------------------------------------------------ 파일 로드
async function loadFiles(fileList) {
  const files = Array.from(fileList || []); if (!files.length) return;
  const main = files.find((f) => /\.(ply|spz|splat|ksplat|sog|zip)$/i.test(f.name));
  const side = files.find((f) => /\.json$/i.test(f.name));
  if (!main) { showError('E02', `놓은 파일: ${files.map((f) => f.name).join(', ')}`); return; }
  const ext = main.name.toLowerCase().split('.').pop();
  $('#loading').hidden = false; $('#loading-text').textContent = `파일을 읽는 중… (${main.name}, ${(main.size / 1e6).toFixed(1)} MB)`; $('#loading-sub').textContent = main.size > 500e6 ? '큰 파일입니다. 1~3분 정도 걸릴 수 있으니 탭을 닫지 마세요.' : '';
  await new Promise((r) => setTimeout(r, 30));
  let buf; try { buf = await main.arrayBuffer(); } catch (e) { $('#loading').hidden = true; showError('E11', String(e)); return; }
  let header = null;
  if (ext === 'ply') {
    header = parsePlyHeader(buf);
    if (!header) { $('#loading').hidden = true; showError('E02', 'PLY 헤더를 읽을 수 없습니다(손상 또는 텍스트 형식).'); return; }
    if (header.is2dgs) { $('#loading').hidden = true; showError('E04'); return; }
    if (!header.has3dgs) { $('#loading').hidden = true; showError('E03', `속성: ${header.names.slice(0, 8).join(', ')}${header.names.length > 8 ? ' …' : ''}`); return; }
    if (header.count > 3e6 || main.size > 700e6) showError('E13', `가우시안 ${header.count.toLocaleString()}개 · 파일 ${(main.size / 1e9).toFixed(2)} GB · 예상 메모리 약 ${(main.size * 2.5 / 1e9).toFixed(1)} GB. 읽는 데 수 분 걸릴 수 있고 실패할 수 있습니다.`);
    $('#loading-sub').textContent = `가우시안 ${header.count.toLocaleString()}개 · SH ${header.shDegree}차 · ${header.compressed ? '압축 PLY' : '3DGS PLY'} — GPU에 올리는 중`;
  }
  // 이전 모델 제거
  if (state.mesh) { scene.remove(state.mesh); try { state.mesh.dispose?.(); } catch (_) {} state.mesh = null; }
  if (state.points3) { scene.remove(state.points3); state.points3 = null; } state.cloud = null;
  resetAll(true); state.coordOffset = null;
  if (header) { // 지역·국가 좌표계처럼 좌표가 크면 원점 이동 (float32 정밀도 보호). 원래 좌표는 origCoord() 로 복원
    const sample = positionsFromPly(buf, header);
    if (sample) { const b = boundsFromPositions(sample); const c = b.center; const big = Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) > Math.max(2000, 200 * b.radius);
      if (big) { const off = [Math.round(c.x), Math.round(c.y), Math.round(c.z)]; if (shiftPlyInPlace(buf, header, off)) { state.coordOffset = off; showError('E14', `오프셋 (${off.join(', ')}) 를 빼서 렌더링합니다. 좌표 크기 ≈ ${Math.max(...off.map(Math.abs)).toLocaleString()} u.<br><b>힌트:</b> 이런 파일은 대개 국가·지역 좌표계(미터)로 만든 것입니다. 축척 배너가 뜨면 [축척 직접 입력]에 <b>1</b> 을 넣으세요(1 u = 1 m). 확실하지 않으면 ① 길이 보정으로 확인하세요.`); } else showError('E13', '좌표가 매우 크지만 이 PLY 구조에서는 원점 이동을 적용하지 못했습니다. 렌더링이 깨질 수 있습니다.'); } }
  }
  const fileType = { ply: 'ply', spz: 'spz', splat: 'splat', ksplat: 'ksplat' }[ext];
  const bigFile = header ? header.count > 1500000 : main.size > 150e6;
  let mesh;
  try {
    mesh = new SplatMesh({ fileBytes: new Uint8Array(buf), fileName: main.name, ...(fileType ? { fileType } : {}), maxSh: bigFile ? 1 : 3 });
    scene.add(mesh);
    await mesh.initialized;
  } catch (e) {
    $('#loading').hidden = true; if (mesh) scene.remove(mesh); console.error(e);
    showError(/unsupported|unknown|format|magic/i.test(String(e)) ? 'E02' : 'E11', `상세: ${String(e).slice(0, 200)}`); return;
  }
  state.mesh = mesh; state.header = header;
  state.file = { name: main.name, size: main.size, ext, count: header ? header.count : (mesh.numSplats || mesh.splats?.numSplats || null) };
  // 경계
  let pos = positionsFromPly(buf, header);
  if (!pos) { try { const src = mesh.splats || mesh.packedSplats; const n = src?.numSplats || 0; const step = Math.max(1, Math.floor(n / 150000)); const arr = []; src?.forEachSplat?.((i, c) => { if (i % step === 0) arr.push(c.x, c.y, c.z); }); if (arr.length) pos = arr; } catch (e) { console.warn('forEachSplat 실패', e); } }
  state.bounds = pos ? boundsFromPositions(pos) : { center: new THREE.Vector3(), radius: 5 };
  state.centers = pos ? Float32Array.from(pos) : null; // 휠 줌의 표면 깊이 추정용 표본
  state.cloud = (header ? buildCloudFromPly(buf, header) : null) || buildCloudFromMesh(mesh); rebuildPoints(); if (state.cloud) state.centers = state.cloud.n > 200000 ? (() => { const step = Math.ceil(state.cloud.n / 200000); const out = new Float32Array(Math.ceil(state.cloud.n / step) * 3); let m = 0; for (let i = 0; i < state.cloud.n; i += step) { out[3 * m] = state.cloud.pos[3 * i]; out[3 * m + 1] = state.cloud.pos[3 * i + 1]; out[3 * m + 2] = state.cloud.pos[3 * i + 2]; m++; } return out.subarray(0, m * 3); })() : state.cloud.pos;
  // 위 방향
  const upFromHeader = header?.upAxis ? { '+z': [0, 0, 1], '-z': [0, 0, -1], '+y': [0, 1, 0], '-y': [0, -1, 0], '+x': [1, 0, 0], '-x': [-1, 0, 0] }[header.upAxis] : null;
  if (upFromHeader) setUp(new THREE.Vector3(...upFromHeader), 'PLY 헤더(up axis)');
  else if (state.coordOffset) { setUp(new THREE.Vector3(0, 0, 1), '큰 좌표(지오리퍼런싱) 파일 → +Z 추정'); showError('E06', '지역·국가 좌표계 파일은 보통 Z 가 높이이므로 +Z 로 가정했습니다.'); }
  else { setUp(new THREE.Vector3(...(ext === 'spz' ? [0, 1, 0] : [0, -1, 0])), null); showError('E06', `현재 가정: ${ext === 'spz' ? '+Y (SPZ 관례)' : '−Y (COLMAP 3DGS 관례)'}`); }
  frameAll();
  // 단위
  let sidecar = null; if (side) { try { sidecar = JSON.parse(await side.text()); } catch (e) { showError('E12', `JSON 구문 오류: ${String(e).slice(0, 80)}`); } }
  resolveUnits(header, sidecar);
  // UI
  $('#loading').hidden = true; $('#dropzone').classList.add('hidden');
  ['#btn-point', '#btn-dist', '#btn-scale', '#btn-export', '#btn-up', '#btn-home', '#btn-navpad', '#btn-analyze', '#btn-view'].forEach((s) => ($(s).disabled = false));
  $('#btn-view').disabled = false; applyViewMode();
  $('#navpad').hidden = !state.settings.navpad;
  glHost.classList.remove('measuring');
  coach('', `<b>${main.name}</b> 열림 (가우시안 ${state.file.count ? state.file.count.toLocaleString() : '?'}개). <b>● 점 측정</b> 또는 <b>↔ 거리 측정</b>을 누르고, 휠로 잴 곳을 확대하세요.`);
  updateCheckDot(); renderResults();
}
function fileKey() { return state.file ? `gsm.calib:${state.file.name}:${state.file.size}` : null; }
function resolveUnits(header, sidecar) {
  const u = { known: false, factor: 1, sigmaRel: 0, source: '' };
  const saved = fileKey() && localStorage.getItem(fileKey());
  if (sidecar) {
    if (typeof sidecar.scale_to_meters === 'number' && sidecar.scale_to_meters > 0) Object.assign(u, { known: true, factor: sidecar.scale_to_meters, sigmaRel: sidecar.scale_sigma_rel || 0, source: `사이드카 JSON (scale_to_meters=${sidecar.scale_to_meters}${sidecar.transform ? ', 실좌표 변환 포함' : ''})`, transform: sidecar.transform && sidecar.transform.R && sidecar.transform.t ? sidecar.transform : null, crs: sidecar.crs || '' });
    else if (/^m(eters?|etres?)?$/i.test(String(sidecar.units || '')) || /meters/i.test(String(sidecar.ply_axes || ''))) Object.assign(u, { known: true, factor: 1, sigmaRel: sidecar.residual_rms_m && sidecar.n_gps_used ? 0.02 : 0, source: sidecar.mode === 'from-gps' ? `사이드카 JSON (gs_ply_georef from-gps, 축척 ${Number(sidecar.scale).toFixed(4)} 적용됨)` : '사이드카 JSON (units: m)' });
    else showError('E12', `키: ${Object.keys(sidecar).slice(0, 6).join(', ')}`);
  }
  if (!u.known && saved) { try { const s = JSON.parse(saved); Object.assign(u, { known: true, factor: s.factor, sigmaRel: s.sigmaRel || 0, source: `이전 보정값 (저장됨, ${new Date(s.when).toLocaleDateString()}${s.source ? ', ' + s.source : ''})`, transform: s.transform || null, crs: s.crs || '' }); } catch (_) {} }
  if (!u.known && header) {
    if (header.scaleToMeters) Object.assign(u, { known: true, factor: header.scaleToMeters, source: 'PLY 헤더 (scale_to_meters)' });
    else if (header.unitsMeters) Object.assign(u, { known: true, factor: 1, source: 'PLY 헤더 (units: meters)' });
  }
  state.unit = u; applyUnitUI();
}
function applyUnitUI() {
  const b = $('#banner');
  if (state.unit.known) { b.hidden = true; $('#unit-label').textContent = `미터 (m)`; $('#unit-source').textContent = `← ${state.unit.source}${state.unit.factor !== 1 ? ` · 1 u = ${state.unit.factor.toPrecision(6)} m` : ''}`; }
  else { b.hidden = false; $('#banner-text').innerHTML = `<b>E05 · 축척 정보 없음:</b> 이 파일에는 "1 단위 = 몇 m" 정보가 없어 <b>미터 거리를 표시할 수 없습니다.</b> 거리는 <b>모델 단위(u)</b>로만 나옵니다. 실제 길이를 아는 구간 하나로 보정하면 미터가 됩니다.`; $('#unit-label').textContent = '모델 단위(u) — 미터 아님'; $('#unit-source').textContent = '축척 정보 없음'; showError('E05'); }
  renderResults(); updateCheckDot();
}

// ------------------------------------------------------------------ 측정 작업
function startTask(kind, extra = {}) {
  if (!state.mesh) return;
  cancelPoint(false);
  state.task = { kind, pts: [], ...extra };
  $$('#btn-point,#btn-dist').forEach((b) => b.classList.remove('active'));
  if (kind === 'point') $('#btn-point').classList.add('active'); if (kind === 'distance') $('#btn-dist').classList.add('active'); $('#btn-analyze').classList.toggle('active', !!GEOM_NEED[kind]);
  glHost.classList.add('measuring'); showTab('measure'); $('#measure-idle').hidden = true; $('#measure-live').hidden = false;
  updateMeasureUI();
}
function taskLabel() {
  const t = state.task; if (!t) return '';
  if (t.kind === 'point') return `점 측정 (P${state.nextId})`;
  if (t.kind === 'distance') return `거리 측정 — ${t.pts.length === 0 ? 'A점' : 'B점'}`;
  if (t.kind === 'calib') return `축척 보정 — ${t.pts.length === 0 ? '기준 구간 A점' : '기준 구간 B점'}`;
  if (t.kind === 'angle') return `각도 측정 — ${['A점(한쪽 끝)', 'B점(꼭짓점)', 'C점(다른 끝)'][t.pts.length] || ''}`;
  if (t.kind === 'polyline') return `길이 측정 — ${t.pts.length + 1}번째 점 (2개 이상 → 완성)`;
  if (t.kind === 'area') return `면적 측정 — ${t.pts.length + 1}번째 꼭짓점 (3개 이상, 순서대로 → 완성)`;
  return '';
}
function endTask() {
  state.task = null; cancelPoint(false);
  $$('#btn-point,#btn-dist,#btn-analyze').forEach((b) => b.classList.remove('active'));
  glHost.classList.remove('measuring'); $('#measure-idle').hidden = false; $('#measure-live').hidden = true; $('#loupe').hidden = true;
  coach('', state.mesh ? '<b>● 점 측정</b> 또는 <b>↔ 거리 측정</b>을 눌러 시작하세요.' : '3DGS 파일을 열어 시작하세요.');
}
function cancelPoint(ui = true) { state.rays = []; state.estimate = null; state.refPatch = null; state.autoRotCount = 0; if (ui) updateMeasureUI(); }
function onMeasureClick(px, py) {
  if (!state.task || !state.mesh) return;
  if (anims.length) { toast('카메라 회전 중입니다. 멈춘 뒤 클릭하세요.', 'info', 1500); return; }
  if (state.rays.length === 0 && directPickEnabled() && !state.forceRay && !state.task.refineId) { const ex = state.task.kind !== 'point' ? pickExistingPoint(px, py) : null; if (!ex) { addPickedPoint(px, py); return; } }
  if (state.rays.length === 0 && state.task.kind !== 'point') { // 이미 잰 점 마커를 클릭하면 그 점을 재사용
    const ex = pickExistingPoint(px, py);
    if (ex) { const t = state.task; if (t.pts.includes(ex) && t.kind !== 'polyline') { toast(`${ex.name} 은 이미 선택되어 있습니다.`, 'warn', 2500); return; } t.pts.push(ex); toast(`기존 점 <b>${ex.name}</b> 사용`, 'info', 2500); taskPointAdded(t); renderResults(); return; }
  }
  let pt = { x: px, y: py }; let note = '';
  if (state.rays.length >= 1) {
    const line = epipolarPolyline(state.rays[0]);
    if (state.settings.snap && state.rays.length === 1) { const nr = nearestOnPolyline(line, pt); if (nr.pt && nr.dist <= 30) { pt = nr.pt; note += `스냅 ${nr.dist.toFixed(0)}px`; } }
    if (state.settings.refine && state.refPatch) {
      const r = refineByTemplate(pt, state.rays.length === 1 ? line : null);
      if (r) { pt = r.pt; note += `${note ? ' · ' : ''}정밀보정 ${r.shift.toFixed(1)}px (유사도 ${r.score.toFixed(2)})`; }
      else if (r === null) note += `${note ? ' · ' : ''}보정 없음`;
    }
  }
  const ray = rayFromPixel(pt.x, pt.y); ray.note = note; ray.viewDir = camera.getWorldDirection(new THREE.Vector3());
  if (state.rays.length === 0) { state.refPatch = grabPatch(pt, 25); }
  state.rays.push(ray);
  recompute();
  const nRays = state.rays.length;
  if (nRays === 1) { const hit = surfaceHitAlongRay(ray.o, ray.d); state.autoPivot = hit ? hit.point.clone() : refPoint(); state.autoAngleDeg = 0; state.autoTiltDeg = 0; }
  else if (state.estimate) state.autoPivot = state.estimate.p.clone();
  updateMeasureUI();
  if (nRays >= state.settings.n) { finishPoint(); return; }
  if (state.settings.autoRotate) { const nx = nextAutoStep(nRays); autoOrbit(nx.deg, nx.kind); } // 클릭 → 선택한 방향·각도로 자동 회전 → 사용자는 같은 점만 다시 클릭
  else if (nRays === 1) { const rp = state.autoPivot || refPoint(); if (rp) moveTarget(rp, 350); }
  else if (state.estimate) moveTarget(state.estimate.p, 350);
}
function recompute() { state.estimate = state.rays.length >= 2 ? intersectRays(state.rays) : null; }
function finishPoint(force = false) {
  if (!state.task) return;
  if (state.rays.length < 2) { showError('E07', `현재 광선 ${state.rays.length}개`); return; }
  const e = state.estimate; if (!e) { showError('E07'); return; }
  if (e.maxAngleDeg < 10 && !force) { showError('E08', `현재 최대 각도 ${e.maxAngleDeg.toFixed(1)}°`, { actions: '<div class="btnrow"><button class="btn small" data-act="force">그래도 확정(비권장)</button><button class="btn small" data-act="undo">마지막 광선 취소</button></div>', onAction: (a) => { if (a === 'force') finishPoint(true); if (a === 'undo') undoRay(); } }); return; }
  if (e.pxRms > 4) showError('E09', `잔차 RMS ${e.pxRms.toFixed(1)} px, σ₀ = ${fmtLen(e.sigma0)}`);
  const pt = { id: state.nextId++, name: `P${state.nextId - 1}`, p: e.p.clone(), sigma0: e.sigma0, cov: e.cov.clone(), n: e.n, quality: e.quality, pxRms: e.pxRms, maxAngleDeg: e.maxAngleDeg, rays: state.rays.map((r) => ({ o: r.o.toArray(), d: r.d.toArray(), screen: r.screen, note: r.note })) };
  const t = state.task;
  if (t.refineId) { const old = state.points.find((q) => q.id === t.refineId); if (old) { Object.assign(old, { p: pt.p, sigma0: pt.sigma0, cov: pt.cov, n: pt.n, quality: pt.quality, method: 'multi', pxRms: pt.pxRms, maxAngleDeg: pt.maxAngleDeg, rays: pt.rays, refinedFrom: old.pickMode }); state.nextId--; toast(`<b>${old.name} 정밀화 완료</b> ${fmtCoord(old.p)} · σ₀ ${fmtLen(old.sigma0)} · 품질 <span class="badge ${old.quality}">${QUALITY[old.quality].label}</span>`, 'good', 6000); cancelPoint(false); endTask(); renderResults(); updateCheckDot(); return; } }
  pt.method = 'multi'; state.points.push(pt); t.pts.push(pt);
  toast(`<b>${pt.name} 확정</b> ${fmtCoord(pt.p)} · σ₀ ${fmtLen(pt.sigma0)} · 품질 <span class="badge ${pt.quality}">${QUALITY[pt.quality].label}</span>`, pt.quality === 'poor' ? 'warn' : 'good', 6000);
  cancelPoint(false);
  taskPointAdded(t);
  renderResults(); updateCheckDot();
}
function addDistance(a, b) {
  const di = distanceInfo(a, b); state.dists.push({ a: a.id, b: b.id });
  toast(`<b>거리 ${a.name}–${b.name}</b> = <span style="font-size:18px">${fmtLen(di.d, di.sigma, true)}</span>${state.unit.known ? '' : ' <span class="muted">(모델 단위 — 축척 보정 필요)</span>'}`, state.unit.known ? 'good' : 'warn', 9000);
  renderResults();
}
function undoRay() { if (!state.rays.length) return; state.rays.pop(); if (state.rays.length === 0) state.refPatch = null; recompute(); updateMeasureUI(); }
function removeWorst() { if (state.rays.length < 3 || !state.estimate) return; let k = 0; state.estimate.residuals.forEach((r, i) => { if (r > state.estimate.residuals[k]) k = i; }); if (k === 0) { toast('가장 어긋난 광선이 1번(기준) 광선입니다. 점을 취소하고 다시 재는 것을 권합니다.', 'warn'); return; } state.rays.splice(k, 1); recompute(); updateMeasureUI(); }

// ------------------------------------------------------------------ 픽셀 읽기 / 템플릿 매칭 / 루페
const scratch = document.createElement('canvas'); const sctx = scratch.getContext('2d', { willReadFrequently: true });
function glRatio() { return renderer.domElement.width / Math.max(1, glHost.clientWidth); }
function grabGray(cx, cy, size) {
  const r = glRatio(); const s = Math.max(1, Math.round(size)); scratch.width = s; scratch.height = s;
  sctx.imageSmoothingEnabled = false; sctx.clearRect(0, 0, s, s);
  try { sctx.drawImage(renderer.domElement, (cx - size / 2) * r, (cy - size / 2) * r, size * r, size * r, 0, 0, s, s); } catch (e) { return null; }
  const d = sctx.getImageData(0, 0, s, s).data; const g = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  return { g, s };
}
function grabPatch(pt, size) { const p = grabGray(pt.x, pt.y, size); if (!p) return null; let m = 0; for (const v of p.g) m += v; m /= p.g.length; let n = 0; for (let i = 0; i < p.g.length; i++) { p.g[i] -= m; n += p.g[i] * p.g[i]; } p.norm = Math.sqrt(n) || 1; return p; }
function ncc(region, R, ox, oy, patch) {
  const s = patch.s; let m = 0; for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) m += region.g[(oy + y) * R + ox + x]; m /= s * s;
  let dot = 0, n = 0; for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = region.g[(oy + y) * R + ox + x] - m; dot += v * patch.g[y * s + x]; n += v * v; }
  return n > 1e-6 ? dot / (Math.sqrt(n) * patch.norm) : -1;
}
function refineByTemplate(pt, line) {
  const patch = state.refPatch; if (!patch) return undefined;
  const half = Math.floor(patch.s / 2), reach = 40; const R = 2 * (reach + half) + 1;
  const region = grabGray(pt.x, pt.y, R); if (!region) return undefined;
  const cands = [];
  if (line) { const nr = nearestOnPolyline(line, pt); const dir = nr.dir || { x: 1, y: 0 }; const nx = -dir.y, ny = dir.x; for (let a = -reach; a <= reach; a++) for (let c = -3; c <= 3; c++) cands.push({ dx: Math.round(a * dir.x + c * nx), dy: Math.round(a * dir.y + c * ny) }); }
  else { for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) cands.push({ dx, dy }); }
  let best = { score: -2 }; let base = -2;
  for (const c of cands) { const ox = reach + c.dx, oy = reach + c.dy; if (ox < 0 || oy < 0 || ox + patch.s > R || oy + patch.s > R) continue; const sc = ncc(region, R, ox, oy, patch); if (c.dx === 0 && c.dy === 0) base = sc; if (sc > best.score) best = { score: sc, dx: c.dx, dy: c.dy }; }
  // 보수적 적용: 사용자 클릭보다 유사도가 뚜렷히 높을 때만, 3번째 이후 클릭은 작은 이동만 허용
  const shift = Math.hypot(best.dx, best.dy);
  if (best.score < 0.6 || best.score < base + 0.05) return null;
  if (shift > (line ? reach : 8)) return null;
  return { pt: { x: pt.x + best.dx, y: pt.y + best.dy }, score: best.score, shift };
}
const loupe = $('#loupe'), loupeCanvas = $('#loupe-canvas'), lctx = loupeCanvas.getContext('2d', { willReadFrequently: true });
const LOUPE_SIZES = { s: 160, m: 260, l: 380 };
let loupeRT = null, loupeBuf = null, loupeImg = null;
// 확대 영역만 카메라 뷰 오프셋으로 별도 렌더 → 화면 픽셀을 늘린 것보다 훨씬 선명. 실패하면 픽셀 복사로 폴백.
function renderLoupeHiRes(x, y, src, Lpx) {
  if (!loupeRT || loupeRT.width !== Lpx) { loupeRT?.dispose(); loupeRT = new THREE.WebGLRenderTarget(Lpx, Lpx, { depthBuffer: true, stencilBuffer: false }); loupeBuf = new Uint8Array(Lpx * Lpx * 4); loupeImg = new ImageData(Lpx, Lpx); }
  const { w, h } = viewSize();
  camera.setViewOffset(w, h, x - src / 2, y - src / 2, src, src);
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(loupeRT); renderer.clear(); renderer.render(scene, camera); renderer.setRenderTarget(prevRT);
  camera.clearViewOffset(); camera.updateProjectionMatrix();
  renderer.readRenderTargetPixels(loupeRT, 0, 0, Lpx, Lpx, loupeBuf);
  const d = loupeImg.data, row = Lpx * 4; // GL 은 아래→위 순서라 세로 반전
  for (let yy = 0; yy < Lpx; yy++) d.set(loupeBuf.subarray((Lpx - 1 - yy) * row, (Lpx - yy) * row), yy * row);
  lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.putImageData(loupeImg, 0, 0);
}
function updateLoupe() {
  const show = state.task && state.settings.loupe && state.mouse.inside && state.mesh && !anims.length;
  loupe.hidden = !show; if (!show) return;
  const z = state.settings.zoom, L = LOUPE_SIZES[state.settings.loupeSize] || 260, src = L / z, r = glRatio(); const { x, y } = state.mouse; const { w, h } = viewSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2), Lpx = Math.round(L * dpr);
  if (loupe.style.width !== L + 'px') { loupe.style.width = loupe.style.height = L + 'px'; }
  if (loupeCanvas.width !== Lpx) { loupeCanvas.width = loupeCanvas.height = Lpx; loupeCanvas.style.width = loupeCanvas.style.height = L + 'px'; }
  let lx = x + 28, ly = y - L - 28; if (lx + L > w - 4) lx = x - L - 28; if (ly < 4) ly = y + 28;
  loupe.style.left = lx + 'px'; loupe.style.top = (ly + parseInt(getComputedStyle(document.documentElement).getPropertyValue('--top-h'))) + 'px';
  let hires = false;
  if (state.settings.loupeHiRes && !state.loupeHiResFailed) { try { renderLoupeHiRes(x, y, src, Lpx); hires = true; } catch (err) { state.loupeHiResFailed = true; console.warn('확대창 고해상도 렌더 실패 → 픽셀 복사로 전환', err); try { camera.clearViewOffset(); renderer.setRenderTarget(null); } catch (_) {} } }
  if (!hires) { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.imageSmoothingEnabled = false; lctx.fillStyle = '#000'; lctx.fillRect(0, 0, Lpx, Lpx); try { lctx.drawImage(renderer.domElement, (x - src / 2) * r, (y - src / 2) * r, src * r, src * r, 0, 0, Lpx, Lpx); } catch (_) {} }
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const T = (p) => ({ x: (p.x - x) * z + L / 2, y: (p.y - y) * z + L / 2 });
  if (state.rays.length) { const line = epipolarPolyline(state.rays[0]); lctx.strokeStyle = '#fbbf24'; lctx.lineWidth = 2; lctx.setLineDash([8, 6]); lctx.beginPath(); let pen = false; for (let i = 0; i < line.length; i++) { const p = line[i]; if (!p.front) { pen = false; continue; } const q = T(p); if (!pen) { lctx.moveTo(q.x, q.y); pen = true; } else lctx.lineTo(q.x, q.y); } lctx.stroke(); lctx.setLineDash([]); }
  if (state.estimate) { const q = T(project(state.estimate.p)); lctx.strokeStyle = '#22d3ee'; lctx.lineWidth = 2; lctx.beginPath(); lctx.arc(q.x, q.y, 8 * z / 2, 0, Math.PI * 2); lctx.stroke(); }
  lctx.strokeStyle = '#22d3ee'; lctx.lineWidth = 1; lctx.beginPath(); lctx.moveTo(L / 2, 0); lctx.lineTo(L / 2, L); lctx.moveTo(0, L / 2); lctx.lineTo(L, L / 2); lctx.stroke();
  lctx.strokeStyle = '#fff'; lctx.beginPath(); lctx.arc(L / 2, L / 2, 6, 0, Math.PI * 2); lctx.stroke();
  $('#loupe-info').textContent = `${z}× · ${hires ? '고해상도' : '픽셀'} · 광선 ${state.rays.length}/${state.settings.n}`;
}

// ------------------------------------------------------------------ 오버레이
function drawOverlay() {
  const { w, h } = viewSize(); octx.clearRect(0, 0, w, h); if (!state.mesh) return;
  const ctx = octx;
  // 측정된 점 · 거리
  if (state.settings.labels) {
    for (const d of state.dists) { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); if (!a || !b) continue; const pa = project(a.p), pb = project(b.p); if (!pa.front || !pb.front) continue; ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke(); const di = distanceInfo(a, b); pill(ctx, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 14, `${a.name}–${b.name}  ${fmtLen(di.d, di.sigma, true)}${state.unit.known ? '' : ' ⚠'}`, '#22d3ee'); }
    for (const g of state.geoms) { const gi = geomInfo(g); if (!gi) continue; const S = gi.pts.map((p) => project(p.p)); if (S.some((q) => !q.front)) continue;
      if (g.type === 'area') { ctx.fillStyle = '#f9731633'; ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2; ctx.beginPath(); S.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.fill(); ctx.stroke(); const cx = S.reduce((a, q) => a + q.x, 0) / S.length, cy = S.reduce((a, q) => a + q.y, 0) / S.length; pill(ctx, cx, cy, `${g.name} ${gi.text}`, '#f97316'); }
      else if (g.type === 'polyline') { ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2; ctx.beginPath(); S.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); const m = S[Math.floor(S.length / 2)]; pill(ctx, m.x + 8, m.y - 12, `${g.name} ${gi.text}`, '#f97316'); }
      else if (g.type === 'angle') { const [A, B, C] = S; ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.stroke(); const a1 = Math.atan2(A.y - B.y, A.x - B.x), a2 = Math.atan2(C.y - B.y, C.x - B.x); let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; ctx.beginPath(); ctx.arc(B.x, B.y, 26, a1, a1 + d, d < 0); ctx.stroke(); const mid = a1 + d / 2; pill(ctx, B.x + 34 * Math.cos(mid), B.y + 34 * Math.sin(mid), `${g.name} ${gi.text}`, '#a78bfa'); }
    }
    if (state.task && GEOM_NEED[state.task.kind] && state.task.pts.length) { const S = state.task.pts.map((p) => project(p.p)).filter((q) => q.front); ctx.strokeStyle = '#f97316'; ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.beginPath(); S.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); if (state.task.kind === 'area' && S.length > 2) ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); }
    for (const p of state.points) { const s = project(p.p); if (!s.front) continue; const col = p.quality === 'good' ? '#22c55e' : p.quality === 'fair' ? '#f59e0b' : '#ef4444'; ctx.fillStyle = state.selected.has(p.id) ? '#fff' : col; ctx.beginPath(); ctx.arc(s.x, s.y, state.selected.has(p.id) ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke(); pill(ctx, s.x + 10, s.y - 10, p.name, col, true); }
  }
  // 진행 중 측정 안내
  if (state.task && state.rays.length) {
    const line = epipolarPolyline(state.rays[0]);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.setLineDash([10, 7]); ctx.beginPath(); let pen = false;
    for (const p of line) { if (!p.front) { pen = false; continue; } if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y); }
    ctx.stroke(); ctx.setLineDash([]);
    const nr = nearestOnPolyline(line, { x: w / 2, y: h / 2 }); if (nr.pt && state.rays.length === 1) pill(ctx, nr.pt.x + 12, nr.pt.y - 22, '안내선: 1번 클릭의 광선 — 이 선 위에서 같은 점을 클릭', '#fbbf24');
    if (state.estimate) { const q = project(state.estimate.p); if (q.front) { ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(q.x - 20, q.y); ctx.lineTo(q.x - 14, q.y); ctx.moveTo(q.x + 14, q.y); ctx.lineTo(q.x + 20, q.y); ctx.moveTo(q.x, q.y - 20); ctx.lineTo(q.x, q.y - 14); ctx.moveTo(q.x, q.y + 14); ctx.lineTo(q.x, q.y + 20); ctx.stroke(); pill(ctx, q.x + 16, q.y + 18, `현재 추정점 · σ₀ ${fmtLen(state.estimate.sigma0)} · 이 근처를 클릭`, '#22d3ee'); } }
    // 클릭 지점 표시 (현재 뷰에서 찍은 광선의 화면 위치는 카메라가 움직이면 의미 없음 → 마지막 클릭이 현 시점일 때만)
    const last = state.rays[state.rays.length - 1]; if (last && last.camPos.distanceToSquared(camera.position) < 1e-12) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(last.screen.x, last.screen.y, 6, 0, Math.PI * 2); ctx.stroke(); }
  }
}
function pill(ctx, x, y, text, color, small = false) { ctx.font = `${small ? 12 : 13}px system-ui, sans-serif`; const tw = ctx.measureText(text).width; const px = 6, hgt = small ? 18 : 20; ctx.fillStyle = '#0b1020d9'; ctx.strokeStyle = color; ctx.lineWidth = 1; roundRect(ctx, x, y - hgt / 2, tw + 2 * px, hgt, 6); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + px, y + 1); }
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ------------------------------------------------------------------ 측정 UI
function currentAngleDeg() { if (!state.rays.length) return 0; const rp = refPoint(); if (!rp) return 0; const v = rp.clone().sub(camera.position).normalize(); return Math.acos(THREE.MathUtils.clamp(v.dot(state.rays[0].d), -1, 1)) / DEG; }
function updateMeasureUI() {
  const live = !!state.task; if (!live) return;
  const n = state.rays.length, N = state.settings.n; const e = state.estimate;
  $('#task-title').textContent = taskLabel(); $('#ray-count').textContent = n; $('#ray-target').textContent = N; $('#progress-bar').style.width = `${Math.min(100, n / N * 100)}%`;
  $('#ray-angle').textContent = e ? `${e.maxAngleDeg.toFixed(0)}°` : '–';
  const box = $('#estimate-box'); box.hidden = !e;
  if (e) { $('#est-coords').textContent = fmtCoord(e.p); $('#est-sigma').textContent = `${fmtLen(e.sigma0)} · 잔차 RMS ${Number.isFinite(e.pxRms) ? e.pxRms.toFixed(1) : '∞'} px`; const b = $('#est-quality'); b.className = `badge ${e.quality}`; b.textContent = QUALITY[e.quality].label; }
  const tb = $('#ray-table tbody'); tb.innerHTML = state.rays.map((r, i) => `<tr><td>${i + 1}</td><td class="num">${e && Number.isFinite(e.pxResid[i]) ? e.pxResid[i].toFixed(1) : '–'}</td><td class="muted">${r.note || ''}</td><td>${i === n - 1 ? '<button class="xbtn" data-undo title="이 광선 취소">✕</button>' : ''}</td></tr>`).join('');
  $('#btn-finish').disabled = n < 2; $('#btn-worst').disabled = n < 3; $('#btn-undo').disabled = n < 1; $('#btn-autorot').disabled = n < 1;
  const t = state.task; const gf = $('#btn-geom-finish'); const need = GEOM_NEED[t.kind];
  $('#task-pts').innerHTML = t.kind === 'point' ? '' : `선택된 점: ${t.pts.length ? t.pts.map((p) => `<b>${p.name}</b>`).join(' → ') : '(없음)'}${need ? ` · 필요 ${need}개 이상` : ''} <span class="muted">— 이미 잰 점(화면 마커)을 클릭하면 재사용</span>`;
  gf.hidden = !(t.kind === 'polyline' || t.kind === 'area'); gf.disabled = n > 0 || t.pts.length < (need || 99);
  const step = `${Math.min(n + 1, N)}/${N}`; const lab = taskLabel();
  if (n === 0 && (t.kind === 'polyline' || t.kind === 'area') && t.pts.length >= (need || 99)) coach(step, `<b>${lab}</b> — 점을 더 재거나, 충분하면 <b>[✔ 완성]</b>(Enter)을 누르세요. 기존 점 마커를 클릭하면 재사용됩니다.`, `선택 ${t.pts.length}개`);
  else if (n === 0 && directPickEnabled() && !t.refineId) coach(step, `<b>${lab}</b> — <b>점군에서 클릭 한 번</b>으로 점을 고릅니다(${state.settings.pickMode === 'nearest' ? '가장 가까운 점 하나' : '앞쪽 군집 중앙값'}). 정밀하게 재려면 <b>Shift+클릭</b>(다시점 광선).`, '직접선택 = 빠르지만 스플랫 두께만큼 불확실');
  else if (n === 0) coach(step, `<b>${lab}</b> — 잴 점을 <b>휠로 크게 확대</b>한 뒤 정확히 클릭하세요. (확대창이 커서 옆에 뜹니다)${t.kind !== 'point' && state.points.length ? ' 이미 잰 점은 마커 클릭으로 재사용.' : ''}`, '오른쪽 드래그: 이동 · 왼쪽 드래그: 회전');
  else if (state.settings.autoRotate) coach(step, `<b>${lab}</b> — 카메라가 자동으로 돌아갔습니다. 화면 중앙 근처(노란 안내선·청록 원)의 <b>같은 점을 클릭</b>하세요. ${N - n}개 남음 · 다음 회전: <b>${nextAutoLabel(n + 1) || '없음(마지막)'}</b> · 방향 바꾸기: <b>← → ↑ ↓</b> 키`, e ? `σ₀ ${fmtLen(e.sigma0)} · 최대각 ${e.maxAngleDeg.toFixed(0)}°` : `누적 좌우 ${state.autoAngleDeg.toFixed(0)}° · 상하 ${state.autoTiltDeg.toFixed(0)}°`);
  else if (n === 1) coach(step, `<b>${lab}</b> — 카메라를 <b>20° 이상 돌린 뒤</b>(왼쪽 드래그 또는 <b>R</b>) 노란 <b>안내선 위</b>에서 같은 점을 클릭하세요.`, '');
  else coach(step, `<b>${lab}</b> — 또 다른 각도에서 같은 점(청록 원 근처)을 클릭하세요. ${N - n}개 남음 · 지금 확정: <b>Enter</b>`, e ? `σ₀ ${fmtLen(e.sigma0)} · 최대각 ${e.maxAngleDeg.toFixed(0)}°` : '');
}
function tickAngleMeter() { if (!state.task || !state.rays.length) return; const a = currentAngleDeg(); const f = $('#angle-fill'); f.style.width = `${Math.min(100, a / 40 * 100)}%`; f.classList.toggle('ok', a >= 20); $('#angle-text').textContent = a >= 20 ? `현재 각도 ${a.toFixed(0)}° — 충분합니다. 같은 점을 클릭하세요` : `현재 각도 ${a.toFixed(0)}° — 카메라를 더 돌리세요 (20° 이상 권장)`; }
setInterval(tickAngleMeter, 120);

// ------------------------------------------------------------------ 결과 패널
function renderResults() {
  $('#results-count').textContent = state.points.length;
  const tb = $('#pt-table tbody'); tb.innerHTML = state.points.map((p) => `<tr class="${state.selected.has(p.id) ? 'sel' : ''}"><td><input type="checkbox" data-sel="${p.id}" ${state.selected.has(p.id) ? 'checked' : ''}></td><td><b>${p.name}</b> <span class="badge ${p.quality}" title="${QUALITY[p.quality].desc}">${QUALITY[p.quality].label}</span></td><td class="mono">${fmtCoord(p.p)}</td><td class="num">${fmtLen(p.sigma0)}</td><td class="num">${p.n}</td><td>${p.method === 'pick' ? `<button class="btn small" data-refine="${p.id}" title="이 점을 다시점 클릭으로 정밀 측정">정밀화</button> ` : ''}<button class="xbtn" data-del="${p.id}" title="삭제">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">아직 측정한 점이 없습니다.</td></tr>';
  $('#pt-legend').hidden = !state.points.length;
  const db = $('#dist-table tbody'); db.innerHTML = state.dists.map((d, i) => { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); if (!a || !b) return ''; const di = distanceDecomp(a, b); return `<tr><td>${a.name}–${b.name}</td><td class="num"><b>${fmtLen(di.d)}</b>${state.unit.known ? '' : ' <span title="축척 정보 없음">⚠</span>'}<br><span class="muted">± ${fmtLen(di.sigma)}</span></td><td class="num">${fmtLen(di.h)}</td><td class="num">${fmtLen(di.v)}</td><td class="num">${di.slopeDeg.toFixed(1)}°<br><span class="muted">${Number.isFinite(di.slopePct) ? di.slopePct.toFixed(1) + ' %' : '수직'}</span></td><td><button class="xbtn" data-ddel="${i}" title="삭제">✕</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">거리 없음 — ↔ 거리 측정 또는 점 2개 체크 후 [선택 두 점 거리]</td></tr>';
  const gb = $('#geom-table tbody'); gb.innerHTML = state.geoms.map((g, i) => { const gi = geomInfo(g); if (!gi) return ''; return `<tr><td>${GEOM_LABEL[g.type]} <b>${g.name}</b><br><span class="muted">${gi.pts.map((p) => p.name).join('→')}</span></td><td class="num"><b>${gi.text}</b>${!state.unit.known && g.type !== 'angle' ? ' <span title="축척 정보 없음">⚠</span>' : ''}<br><span class="muted">${gi.extra}</span></td><td><button class="xbtn" data-gdel="${i}" title="삭제">✕</button></td></tr>`; }).join('') || '<tr><td colspan="3" class="muted">없음 — 📐 분석 메뉴에서 각도(A)·길이(L)·면적(P)</td></tr>';
  $('#btn-dist-sel').disabled = state.selected.size !== 2;
}
function updateCheckDot() {
  const d = $('#check-dot'); let cls = 'ok';
  if (!state.webgl2) cls = 'bad'; else if (!state.mesh) cls = ''; else if (!state.unit.known) cls = 'warn';
  if (state.estimate && (state.estimate.maxAngleDeg < 10 || state.estimate.pxRms > 4)) cls = 'bad';
  d.className = `dot ${cls}`;
}

// ------------------------------------------------------------------ 모달
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }
$('#modal-close').onclick = closeModal; $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
function openChecklist() {
  const items = []; const it = (st, title, body, fix = '') => items.push({ st, title, body, fix });
  it(state.webgl2 ? 'ok' : 'bad', 'WebGL2', state.webgl2 ? '사용 가능' : ERRORS.E01.why, state.webgl2 ? '' : ERRORS.E01.fix);
  if (!state.file) it('na', '파일', '아직 열지 않음', '파일을 끌어다 놓거나 [파일 열기]');
  else { const f = state.file, h = state.header; it('ok', '파일', `${f.name} · ${(f.size / 1e6).toFixed(1)} MB · ${f.ext.toUpperCase()}${f.count ? ` · 가우시안 ${f.count.toLocaleString()}개` : ''}${h ? ` · SH ${h.shDegree}차${h.compressed ? ' · 압축 PLY' : ''}` : ''}`); if (h) it('ok', '3DGS 속성', h.compressed ? 'SuperSplat 압축 PLY (렌더러가 해석)' : `opacity · scale_0~2 · rot_0~3 확인`); else it('ok', '3DGS 속성', `${f.ext.toUpperCase()} 형식 — 렌더러(Spark)가 해석함`); }
  if (state.file) { if (state.unit.known) it('ok', '축척 (1 u → m)', `${state.unit.source} · 1 u = ${state.unit.factor.toPrecision(6)} m${state.unit.sigmaRel ? ` · 축척 상대 불확도 ≈ ${(state.unit.sigmaRel * 100).toFixed(1)} %` : ''}`); else it('warn', '축척 (1 u → m)', ERRORS.E05.why, ERRORS.E05.fix); if (state.coordOffset) it('ok', '좌표 원점 이동', `파일 좌표가 커서 뷰어 내부에서 (${state.coordOffset.join(', ')}) 를 뺐습니다. 표시·내보내기 좌표는 원래 값입니다.`); it(state.upSource ? 'ok' : 'warn', '위(上) 방향', state.upSource ? `${state.upSource}: ${$('#up-label').textContent}` : `정보 없음 → ${$('#up-label').textContent} 가정 (측정 정확도 무관)`, state.upSource ? '' : ERRORS.E06.fix); }
  if (state.task) { const n = state.rays.length, e = state.estimate; if (n < 2) it('bad', '진행 중 측정: 광선 수', `${n}개 — ${ERRORS.E07.why}`, ERRORS.E07.fix); else { it(e.maxAngleDeg >= 20 ? 'ok' : e.maxAngleDeg >= 10 ? 'warn' : 'bad', '진행 중 측정: 광선 각도', `최대 ${e.maxAngleDeg.toFixed(1)}° (20° 이상 권장)`, e.maxAngleDeg < 20 ? ERRORS.E08.fix : ''); it(e.pxRms <= 1.5 ? 'ok' : e.pxRms <= 4 ? 'warn' : 'bad', '진행 중 측정: 광선 잔차', `RMS ${e.pxRms.toFixed(1)} px · σ₀ ${fmtLen(e.sigma0)}`, e.pxRms > 4 ? ERRORS.E09.fix : ''); } }
  if (state.cloud) it('ok', '점군', `가우시안 중심 ${state.cloud.n.toLocaleString()}점 · 보기 ${state.settings.viewMode} · 1클릭 방식 ${state.settings.pickMode === 'nearest' ? '가장 가까운 점' : '군집 중앙값'} · 원뿔 ${state.settings.pickRadius} px`); it(state.points.length ? 'ok' : 'na', '결과', `점 ${state.points.length}개 · 거리 ${state.dists.length}개${state.points.length && !state.unit.known ? ' · ⚠ 모두 모델 단위' : ''}`);
  openModal(`<h2>정보 점검</h2><p class="muted small">측정에 필요한 정보가 갖춰졌는지 확인합니다. 빨강은 진행 불가, 노랑은 결과에 제한이 있음을 뜻합니다.</p><ul class="checklist">${items.map((x) => `<li><span class="st ${x.st}">${{ ok: '✓', warn: '!', bad: '✕', na: '–' }[x.st]}</span><span class="body"><b>${x.title}</b>${x.body}${x.fix ? `<div class="fix">👉 ${x.fix}</div>` : ''}</span></li>`).join('')}</ul>`);
}
function openHelp() {
  openModal(`<h2>도움말</h2><p>이 앱은 논문 <i>Accurate Point Measurement in 3DGS</i> (Deng &amp; Qin, 2026)의 방법으로, 같은 점을 여러 각도에서 클릭해 3D 좌표와 거리를 잽니다.</p>
  <div class="btnrow"><button class="btn primary" id="help-tour">▶ 기능 소개 투어 (1분)</button><a class="btn" href="help.html" target="_blank">📖 전체 사용법 · FAQ 열기</a></div>
  <h3>기본 순서</h3><ol><li>파일 열기 (.ply/.spz/.splat/.ksplat/.sog)</li><li>[● 점 측정] → 잴 점을 확대해 클릭 → 카메라를 20° 이상 돌려 안내선 위의 같은 점 클릭 × 5</li><li>[↔ 거리 측정]으로 두 점을 재면 거리 표시</li><li>축척이 없다는 배너가 뜨면 [축척 보정]으로 아는 길이 하나를 재서 미터로 전환</li><li>[내보내기]로 CSV/JSON/PNG 저장</li></ol>
  <h3>마우스 · 키</h3><div class="kv"><span>왼쪽 드래그</span><span>회전</span><span>휠</span><span>커서 방향으로 확대/축소</span><span>오른쪽 드래그</span><span>이동</span><span>클릭(측정 중)</span><span>광선 추가</span><span>M / D</span><span>점 측정 / 거리 측정</span><span>R</span><span>자동 회전 35°</span><span>Enter / Esc</span><span>점 확정 / 취소</span><span>Backspace</span><span>마지막 광선 취소</span><span>F / H</span><span>추정점에 초점 / 홈</span></div>`);
  $('#help-tour').onclick = () => { closeModal(); runTour(); };
}
function openCalibWizard() {
  if (!state.mesh) return;
  const n = state.points.length;
  openModal(`<h2>축척(실제 크기) 맞추기 — 방법 고르기</h2>
  <p class="muted small">이 모델의 좌표는 "모델 단위(u)"입니다. 실제 크기를 알려면 아래 셋 중 하나가 필요합니다. 지금 상태: <b>${state.unit.known ? '축척 있음 (' + state.unit.source + ')' : '축척 없음'}</b> · 측정한 점 ${n}개</p>
  <div class="feature-cards" style="grid-template-columns:1fr;text-align:left">
    <div class="card"><b>① 길이 하나로</b><span>실제 길이를 아는 구간(줄자로 잰 문 폭, A4 긴 변 297 mm 등)의 <b>양 끝점을 이 앱에서 측정</b>하면 축척 = 참값 ÷ 측정값. 축척만 계산됩니다.</span><div class="btnrow"><button class="btn primary small" id="cal-m1">길이로 보정 시작</button></div></div>
    <div class="card"><b>② 기준점(GCP) 좌표로</b><span>실제 좌표를 아는 지점(측량 기준점·GCP 표지 등)을 <b>2개 이상 이 앱에서 측정</b>한 뒤, 각 점의 실제 X·Y·Z 를 <b>단위를 골라</b> 입력합니다. 2점이면 축척, <b>3점 이상이면 축척 + 회전 + 이동</b>까지 구해 모든 좌표를 실제 좌표계(예: EPSG:5186 m)로 표시합니다. 국가좌표처럼 큰 숫자도 그대로 넣으면 됩니다.</span><div class="btnrow"><button class="btn primary small" id="cal-m2">기준점 좌표 입력${n < 2 ? ' (먼저 점 2개 이상 측정)' : ` (${n}개 점)`}</button></div></div>
    <div class="card"><b>③ 축척 숫자를 이미 알 때</b><span>"모델 1 단위 = 실제 몇 m" 를 아는 경우(예: gs_ply_georef.py 출력 4.2015, GCP 지오리퍼런싱 Scale 9.7429). 숫자 하나만 입력합니다.</span><div class="btnrow"><button class="btn small" id="cal-m3">축척 직접 입력</button></div></div>
  </div>`);
  $('#cal-m1').onclick = openLengthCalib; $('#cal-m2').onclick = openGcpCalib; $('#cal-m3').onclick = openManualScale;
}
function openLengthCalib() {
  openModal(`<h2>① 길이 하나로 보정</h2><div class="wizard-steps"><span class="done"></span><span></span><span></span></div>
  <p><b>1단계.</b> 실제 길이를 <b>정확히 아는 구간</b>을 정하고 그 길이(참값)를 입력합니다. 예: A4 용지 긴 변 <b>297 mm</b>, 줄자로 잰 문 폭, 두 측량 기준점 사이 거리. 길수록(수 m) 축척이 정확해집니다.</p>
  <div class="form-row"><label>참값(실제 길이)</label><input id="cal-val" type="number" step="any" min="0" placeholder="예: 297"><select id="cal-unit"><option value="mm">mm</option><option value="cm">cm</option><option value="m" selected>m</option></select><input id="cal-desc" type="text" placeholder="설명(선택): 예) 1층 출입문 폭" style="flex:1;min-width:160px"></div>
  <p class="muted small">2단계에서 그 구간의 <b>양 끝점</b>을 보통 점 측정과 똑같이(각 5회 클릭) 잽니다. 3단계에서 축척 = 참값 ÷ 측정값 을 계산해 적용합니다.</p>
  <div class="btnrow"><button class="btn primary" id="cal-start">2단계: 양 끝점 측정 시작</button><button class="btn ghost" id="cal-back">← 다른 방법</button></div>`);
  $('#cal-start').onclick = () => { const v = parseFloat($('#cal-val').value); const u = $('#cal-unit').value; if (!(v > 0)) { showError('E10', '참값을 먼저 입력하세요.'); return; } const trueLen = v * (u === 'mm' ? 0.001 : u === 'cm' ? 0.01 : 1); closeModal(); startTask('calib', { trueLen, desc: $('#cal-desc').value }); toast(`<b>길이 보정 2단계</b> 참값 ${trueLen} m 구간의 <b>A점</b>을 재세요 (5회 클릭)`, 'info', 6000); };
  $('#cal-back').onclick = openCalibWizard;
}
// ---- 기준점(GCP) 좌표 → 유사변환 (Horn 1987 단위쿼터니언 최소제곱)
function jacobiEigen4(A) { // 대칭 4x4 최대 고유벡터
  const n = 4; const a = A.map((r) => r.slice()); const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]; if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue; const th = (a[q][q] - a[p][p]) / (2 * a[p][q]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)); const c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s2 * akq; a[k][q] = s2 * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s2 * aqk; a[q][k] = s2 * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s2 * vkq; v[k][q] = s2 * vkp + c * vkq; }
    }
  }
  let best = 0; for (let i = 1; i < n; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}
function similarityFromPairs(P, Q) { // P: 모델 좌표(Vector3[]), Q: 실좌표 m (Vector3[]) → {s, R(9, row-major), t[3], residuals[], rms, mode}
  const n = P.length; const pm = new THREE.Vector3(), qm = new THREE.Vector3(); P.forEach((p) => pm.add(p)); Q.forEach((q) => qm.add(q)); pm.divideScalar(n); qm.divideScalar(n);
  const Pc = P.map((p) => p.clone().sub(pm)), Qc = Q.map((q) => q.clone().sub(qm));
  let mode = 'similarity';
  let ext = 0; Pc.forEach((p) => (ext = Math.max(ext, p.length()))); let area = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) area = Math.max(area, new THREE.Vector3().crossVectors(Pc[i], Pc[j]).length());
  if (n < 3 || area < 1e-3 * ext * ext) mode = 'scale-only'; // 2점이거나 한 줄 위 → 회전 결정 불가
  let s, R;
  if (mode === 'scale-only') { let num = 0, den = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { num += Qc[i].distanceTo(Qc[j]); den += Pc[i].distanceTo(Pc[j]); } s = num / den; R = [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
  else {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let k = 0; k < n; k++) { const p = Pc[k], q = Qc[k]; const pa = [p.x, p.y, p.z], qa = [q.x, q.y, q.z]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += pa[a] * qa[b]; }
    const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
    const N = [[Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx], [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz], [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy], [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
    const [w, x, y, z] = jacobiEigen4(N); const q = new THREE.Quaternion(x, y, z, w).normalize(); const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
    let num = 0, den = 0; for (let k = 0; k < n; k++) { const p = Pc[k]; const rp = new THREE.Vector3(R[0] * p.x + R[1] * p.y + R[2] * p.z, R[3] * p.x + R[4] * p.y + R[5] * p.z, R[6] * p.x + R[7] * p.y + R[8] * p.z); num += Qc[k].dot(rp); den += p.lengthSq(); } s = num / den;
  }
  const rp = (p) => new THREE.Vector3(s * (R[0] * p.x + R[1] * p.y + R[2] * p.z), s * (R[3] * p.x + R[4] * p.y + R[5] * p.z), s * (R[6] * p.x + R[7] * p.y + R[8] * p.z));
  const t = qm.clone().sub(rp(pm)); const tt = [t.x, t.y, t.z];
  const residuals = P.map((p, k) => rp(p).add(t).distanceTo(Q[k])); const rms = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n);
  return { s, R, t: tt, residuals, rms, mode, extent: ext };
}
function openGcpCalib() {
  const pts = state.points;
  if (pts.length < 2) { openModal(`<h2>② 기준점(GCP) 좌표로 보정</h2><p>먼저 실제 좌표를 아는 지점을 <b>2개 이상</b> 이 앱에서 측정하세요(각 5회 클릭). 예: GCP 표지 중심, 측량한 모서리. 측정한 점이 결과 탭에 쌓이면 이 화면에서 각 점의 실제 좌표를 입력합니다.</p><div class="btnrow"><button class="btn primary" id="gcp-go">점 측정 시작</button><button class="btn ghost" id="gcp-back">← 다른 방법</button></div>`); $('#gcp-go').onclick = () => { closeModal(); startTask('point'); }; $('#gcp-back').onclick = openCalibWizard; return; }
  const g = state.gcpInputs; const rows = pts.map((p) => { const v = g[p.name] || {}; return `<tr><td><b>${p.name}</b><br><span class="muted small mono">${fmtCoord(p.p)}</span></td><td><input data-gcp="${p.name}" data-k="x" type="number" step="any" placeholder="X (동/E)" value="${v.x ?? ''}" style="width:118px"></td><td><input data-gcp="${p.name}" data-k="y" type="number" step="any" placeholder="Y (북/N)" value="${v.y ?? ''}" style="width:118px"></td><td><input data-gcp="${p.name}" data-k="z" type="number" step="any" placeholder="Z (높이)" value="${v.z ?? ''}" style="width:96px"></td></tr>`; }).join('');
  openModal(`<h2>② 기준점(GCP) 좌표로 보정</h2>
  <p class="small">측정한 점마다 <b>실제 좌표</b>를 입력하세요. 비워 둔 점은 계산에서 빠집니다. <b>단위</b>는 입력한 숫자의 단위입니다(측량 성과가 m 이면 m). 좌표계 이름은 표시용입니다.</p>
  <div class="form-row"><label>입력 단위</label><select id="gcp-unit"><option value="m" selected>m</option><option value="cm">cm</option><option value="mm">mm</option></select><label>좌표계 이름(선택)</label><input id="gcp-crs" type="text" placeholder="예: EPSG:5186 (한국 중부원점)" value="${state.unit.crs || ''}" style="flex:1;min-width:180px"></div>
  <table><thead><tr><th>측정한 점 (현재 표시 좌표)</th><th>실제 X</th><th>실제 Y</th><th>실제 Z</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted small">2점 → 축척만 (두 점 사이 실제 거리 ÷ 측정 거리). 3점 이상(한 줄 위가 아닌) → 축척 + 회전 + 이동을 최소제곱으로 구하고, 이후 모든 좌표를 실제 좌표계로 표시합니다. 점이 많을수록 정확하며 잔차(RMS)로 품질을 확인할 수 있습니다.</p>
  <div class="btnrow"><button class="btn primary" id="gcp-calc">계산</button><button class="btn ghost" id="gcp-back">← 다른 방법</button></div><div id="gcp-result"></div>`);
  $('#gcp-back').onclick = openCalibWizard;
  const readInputs = () => $$('[data-gcp]').forEach((inp) => { const nm = inp.dataset.gcp; g[nm] = g[nm] || {}; g[nm][inp.dataset.k] = inp.value === '' ? undefined : +inp.value; });
  $$('[data-gcp]').forEach((inp) => (inp.onchange = readInputs));
  $('#gcp-calc').onclick = () => {
    readInputs();
    const f = { m: 1, cm: 0.01, mm: 0.001 }[$('#gcp-unit').value]; const crs = $('#gcp-crs').value.trim();
    const used = pts.filter((p) => { const v = g[p.name]; return v && [v.x, v.y, v.z].every((q) => Number.isFinite(q)); });
    if (used.length < 2) { showError('E10', `실제 좌표(X·Y·Z 모두)가 입력된 점이 ${used.length}개입니다. 2개 이상 필요합니다.`); return; }
    const P = used.map((p) => origCoord(p.p)), Q = used.map((p) => new THREE.Vector3(g[p.name].x * f, g[p.name].y * f, g[p.name].z * f));
    const r = similarityFromPairs(P, Q); if (!(r.s > 0) || !Number.isFinite(r.s)) { showError('E10', '같은 위치의 점이 있거나 좌표가 잘못되었습니다.'); return; }
    const resRows = used.map((p, k) => `<tr><td>${p.name}</td><td class="num">${r.residuals[k].toFixed(3)} m</td></tr>`).join('');
    $('#gcp-result').innerHTML = `<h3>결과 (${used.length}점, ${r.mode === 'similarity' ? '축척 + 회전 + 이동' : '축척만 — 점이 2개이거나 한 줄 위에 있음'})</h3>
      <div class="kv"><span>축척</span><b class="bigval">1 u = ${r.s.toPrecision(6)} m</b><span>잔차 RMS</span><b>${r.rms.toFixed(3)} m</b>${r.mode === 'similarity' ? `<span>이동 t</span><b class="mono">(${r.t.map((v) => v.toFixed(3)).join(', ')})</b>` : ''}</div>
      <table><thead><tr><th>점</th><th>잔차</th></tr></thead><tbody>${resRows}</tbody></table>
      ${r.rms > 0.05 * Math.max(0.2, r.extent * r.s) ? '<p class="small" style="color:#f59e0b">⚠ 잔차가 큽니다. 좌표 입력 오류(X/Y 바뀜, 단위)나 점 측정 오류를 확인하세요.</p>' : ''}
      <div class="btnrow"><button class="btn primary" id="gcp-apply">적용</button><button class="btn" id="gcp-json">적용 + 사이드카 JSON 저장</button></div>`;
    const apply = () => {
      const transform = r.mode === 'similarity' ? { s: r.s, R: r.R, t: r.t } : null;
      state.unit = { known: true, factor: r.s, sigmaRel: r.extent > 0 ? r.rms / (r.extent * r.s) : 0, source: `기준점 ${used.length}개 (${r.mode === 'similarity' ? '축척+회전+이동' : '축척'}, RMS ${r.rms.toFixed(3)} m${crs ? ', ' + crs : ''})`, transform, crs };
      try { localStorage.setItem(fileKey(), JSON.stringify({ factor: r.s, sigmaRel: state.unit.sigmaRel, when: Date.now(), source: state.unit.source, transform, crs })); } catch (_) {}
      applyUnitUI(); toast(`<b>기준점 보정 적용</b> 1 u = ${r.s.toPrecision(6)} m${transform ? ' · 좌표가 실제 좌표계로 표시됩니다' : ''}`, 'good');
    };
    $('#gcp-apply').onclick = () => { apply(); closeModal(); };
    $('#gcp-json').onclick = () => { apply(); download(`${state.file.name}.scale.json`, JSON.stringify({ units: 'model', scale_to_meters: r.s, scale_sigma_rel: state.unit.sigmaRel, transform: state.unit.transform, crs, gcp: used.map((p, k) => ({ point: p.name, model: origCoord(p.p).toArray(), real_m: Q[k].toArray(), residual_m: r.residuals[k] })), file: { name: state.file.name, size: state.file.size }, generated_by: '3DGS 다시점 거리 측정기', when: new Date().toISOString() }, null, 2), 'application/json'); closeModal(); };
  };
}
function openCalibResult(t, di) {
  if (!(di.d > 1e-9) || !(t.trueLen > 0)) { showError('E10', `측정 거리 ${di.d}`); return; }
  const s = t.trueLen / di.d; const rel = di.sigma / di.d;
  openModal(`<h2>① 길이 보정 결과</h2><div class="wizard-steps"><span class="done"></span><span class="done"></span><span class="done"></span></div>
  <div class="kv"><span>측정 거리 (모델 단위)</span><b>${di.d.toFixed(5)} u ± ${di.sigma.toFixed(5)}</b><span>참값</span><b>${t.trueLen} m ${t.desc ? `(${t.desc})` : ''}</b><span>축척 = 참값 ÷ 측정</span><b class="bigval">1 u = ${s.toPrecision(6)} m</b><span>축척 상대 불확도</span><b>≈ ${(rel * 100).toFixed(2)} %</b></div>
  <p class="muted small">적용하면 모든 점 좌표·거리가 미터로 표시되고, 이 파일(이름+크기)에 대해 브라우저에 저장되어 다음에 다시 열 때 자동 적용됩니다. 다른 컴퓨터에서도 쓰려면 사이드카 JSON을 내려받아 파일 옆에 두세요.</p>
  <div class="btnrow"><button class="btn primary" id="cal-apply">적용</button><button class="btn" id="cal-json">적용 + 사이드카 JSON 저장</button><button class="btn ghost" id="cal-cancel">취소</button></div>`);
  const apply = () => { state.unit = { known: true, factor: s, sigmaRel: rel, source: `길이 보정 (참값 ${t.trueLen} m${t.desc ? ', ' + t.desc : ''})` }; try { localStorage.setItem(fileKey(), JSON.stringify({ factor: s, sigmaRel: rel, when: Date.now(), trueLen: t.trueLen, desc: t.desc, source: state.unit.source })); } catch (_) {} applyUnitUI(); toast(`<b>축척 적용</b> 1 u = ${s.toPrecision(6)} m — 이제 거리가 미터로 표시됩니다.`, 'good'); };
  $('#cal-apply').onclick = () => { apply(); closeModal(); };
  $('#cal-json').onclick = () => { apply(); download(`${state.file.name}.scale.json`, JSON.stringify({ units: 'model', scale_to_meters: s, scale_sigma_rel: rel, calibrated_with: { true_length_m: t.trueLen, measured_model_units: di.d, desc: t.desc }, file: { name: state.file.name, size: state.file.size }, generated_by: '3DGS 다시점 거리 측정기', when: new Date().toISOString() }, null, 2), 'application/json'); closeModal(); };
  $('#cal-cancel').onclick = closeModal;
}
function openManualScale() {
  openModal(`<h2>③ 축척 직접 입력</h2><p>이 모델에서 <b>모델 좌표 1 단위(u)가 실제로 몇 m</b>인지 이미 아는 경우에만 사용하세요. (예: gs_ply_georef.py 가 출력한 축척 4.2015, GCP 지오리퍼런싱 결과의 Scale 9.7429.) 실제 좌표를 아는 기준점이 있다면 <a href="#" id="man-gcp">② 기준점 좌표로 보정</a>이 더 정확합니다.</p><div class="form-row"><label>모델 1 u = 실제</label><input id="man-s" type="number" step="any" min="0" placeholder="예: 4.2015"><span>m</span><input id="man-src" type="text" placeholder="출처(선택)" style="flex:1;min-width:160px"></div><div class="btnrow"><button class="btn primary" id="man-apply">적용</button><button class="btn ghost" id="man-reset">축척 정보 지우기(모델 단위로)</button></div>`);
  $('#man-gcp').onclick = (e) => { e.preventDefault(); openGcpCalib(); };
  $('#man-apply').onclick = () => { const s = parseFloat($('#man-s').value); if (!(s > 0)) { showError('E10', '축척은 0보다 큰 숫자여야 합니다.'); return; } state.unit = { known: true, factor: s, sigmaRel: 0, source: `직접 입력${$('#man-src').value ? ' (' + $('#man-src').value + ')' : ''}` }; try { localStorage.setItem(fileKey(), JSON.stringify({ factor: s, sigmaRel: 0, when: Date.now(), manual: true })); } catch (_) {} applyUnitUI(); closeModal(); };
  $('#man-reset').onclick = () => { try { localStorage.removeItem(fileKey()); } catch (_) {} state.unit = { known: false, factor: 1, sigmaRel: 0, source: '' }; applyUnitUI(); closeModal(); };
}
function openExport() {
  if (!state.points.length) { toast('내보낼 측정 결과가 없습니다. 먼저 점을 재세요.', 'warn'); return; }
  openModal(`<h2>내보내기</h2><p class="muted small">단위: ${state.unit.known ? `미터 (${state.unit.source})` : '<b>모델 단위(u)</b> — 축척 정보가 없어 미터 열은 비어 있습니다'}</p><div class="btnrow"><button class="btn primary" id="ex-csv">CSV (점 + 거리)</button><button class="btn" id="ex-json">JSON (공분산·광선 포함)</button><button class="btn" id="ex-png">PNG 스크린샷</button></div>`);
  $('#ex-csv').onclick = () => { const f = state.unit.known ? state.unit.factor : null; let csv = '﻿type,id,name,x_model,y_model,z_model,sigma0_model,x_m,y_m,z_m,sigma0_m,n_rays,quality,px_rms,max_angle_deg,x_real,y_real,z_real,crs,method\n'; for (const p of state.points) { const po = origCoord(p.p); const rr = toReal(po); csv += `point,${p.id},${p.name},${po.x},${po.y},${po.z},${p.sigma0},${f ? po.x * f : ''},${f ? po.y * f : ''},${f ? po.z * f : ''},${f ? p.sigma0 * f : ''},${p.n},${p.quality},${p.pxRms.toFixed(2)},${p.maxAngleDeg.toFixed(1)},${rr ? rr.x : ''},${rr ? rr.y : ''},${rr ? rr.z : ''},${rr ? state.unit.crs || '' : ''},${p.method === 'pick' ? 'direct_pick_' + (p.pickMode || '') : 'multi_ray'}\n`; } csv += '\ntype,a,b,dist_model,sigma_model,dist_m,sigma_m,horizontal_m,vertical_m,slope_deg,slope_pct,unit_source\n'; for (const d of state.dists) { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); if (!a || !b) continue; const di = distanceDecomp(a, b); csv += `distance,${a.name},${b.name},${di.d},${di.sigma},${f ? di.d * f : ''},${f ? Math.sqrt((di.sigma * f) ** 2 + (di.d * f * state.unit.sigmaRel) ** 2) : ''},${f ? di.h * f : ''},${f ? di.v * f : ''},${di.slopeDeg.toFixed(3)},${Number.isFinite(di.slopePct) ? di.slopePct.toFixed(2) : ''},"${state.unit.known ? state.unit.source : '축척 정보 없음(모델 단위)'}"\n`; }
    csv += '\ntype,name,points,value,sigma,unit,detail\n'; for (const g of state.geoms) { const gi = geomInfo(g); if (!gi) continue; const unit = g.type === 'angle' ? 'deg' : g.type === 'area' ? (f ? 'm2' : 'u2') : (f ? 'm' : 'u'); const k = g.type === 'angle' ? 1 : g.type === 'area' ? (f ? f * f : 1) : (f || 1); csv += `${g.type},${g.name},${gi.pts.map((p) => p.name).join('>')},${(gi.main * k)},${(gi.sigma * k)},${unit},"${gi.extra}"\n`; } download(`${state.file.name}.measurements.csv`, csv, 'text/csv'); };
  $('#ex-json').onclick = () => download(`${state.file.name}.measurements.json`, JSON.stringify({ file: state.file, unit: state.unit, up: $('#up-label').textContent, coord_offset_subtracted_in_viewer: state.coordOffset, points: state.points.map((p) => ({ ...p, p: origCoord(p.p).toArray(), p_viewer: p.p.toArray(), cov: p.cov.toArray() })), geometries: state.geoms.map((g) => { const gi = geomInfo(g); return { ...g, value: gi?.main, sigma: gi?.sigma, text: gi?.text, extra: gi?.extra }; }), distances: state.dists.map((d) => { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); const di = a && b ? distanceInfo(a, b) : null; return { a: d.a, b: d.b, dist_model: di?.d, sigma_model: di?.sigma }; }), method: 'Deng & Qin 2026 multi-ray least-squares spatial intersection', when: new Date().toISOString() }, null, 2), 'application/json');
  $('#ex-png').onclick = () => { const gl = renderer.domElement; const c = document.createElement('canvas'); c.width = gl.width; c.height = gl.height; const x = c.getContext('2d'); x.drawImage(gl, 0, 0); x.drawImage(overlay, 0, 0, c.width, c.height); c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${state.file.name}.measure.png`; a.click(); }); };
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }

// ------------------------------------------------------------------ 이벤트
function showTab(name) { $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name)); $$('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name)); }
$$('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
$('#btn-open').onclick = $('#drop-open').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };
async function loadSample() {
  $('#loading').hidden = false; $('#loading-text').textContent = '샘플을 내려받는 중… (진주 LH 현장, 약 10 MB)';
  try { const r = await fetch('sample/site01_150k_sh0.ply'); if (!r.ok) throw new Error(r.status); const blob = await r.blob(); const f = new File([blob], 'site01_150k_sh0.ply'); let side = null; try { const rj = await fetch('sample/site01_150k_sh0.ply.json'); if (rj.ok) side = new File([await rj.blob()], 'site01_150k_sh0.ply.json'); } catch (_) {} await loadFiles(side ? [f, side] : [f]); }
  catch (e) { $('#loading').hidden = true; toast(`샘플을 불러올 수 없습니다 (${e}). 인터넷/서버 경로를 확인하거나 직접 파일을 여세요.`, 'warn', 8000); }
}
$('#btn-sample').onclick = $('#drop-sample').onclick = loadSample;
$('#drop-tour').onclick = $('#btn-tour').onclick = () => runTour();
$('#btn-help').onclick = openHelp; $('#btn-check').onclick = openChecklist; $('#btn-export').onclick = openExport;
$('#btn-scale').onclick = $('#banner-calib').onclick = openCalibWizard; $('#banner-manual').onclick = $('#btn-scale-manual').onclick = openManualScale;
$('#banner-dismiss').onclick = () => { $('#banner').hidden = true; toast('모델 단위로 계속합니다. 거리 표시의 ⚠ 는 미터가 아님을 뜻합니다.', 'warn', 6000); };
$('#btn-point').onclick = () => (state.task?.kind === 'point' ? endTask() : startTask('point'));
$('#btn-dist').onclick = () => (state.task?.kind === 'distance' ? endTask() : startTask('distance'));
$('#btn-home').onclick = frameAll;
$('#btn-up').onclick = (e) => { e.stopPropagation(); $('#btn-up').parentElement.classList.toggle('open'); };
document.addEventListener('click', () => $('#btn-up').parentElement.classList.remove('open'));
$$('#menu-up button').forEach((b) => (b.onclick = () => setUp(new THREE.Vector3(...b.dataset.up.split(',').map(Number)), '사용자 선택')));
$('#btn-autorot').onclick = () => autoRotate();
$('#live-autorot').onclick = () => setSetting('autoRotate', !state.settings.autoRotate);
$$('#live-loupe-size button, #set-loupe-size button').forEach((b) => (b.onclick = () => setSetting('loupeSize', b.dataset.ls)));
$('#set-autorot').onchange = (e) => setSetting('autoRotate', e.target.checked);
$('#set-navpad').onchange = (e) => setSetting('navpad', e.target.checked);
$('#set-ptsize').oninput = (e) => setSetting('ptSize', +e.target.value); $('#set-ptmode').onchange = (e) => { setSetting('ptMode', e.target.value); rebuildPoints(); }; $('#q-ptmode').onchange = (e) => { setSetting('ptMode', e.target.value); rebuildPoints(); }; $('#set-hidebig').onchange = (e) => { setSetting('hideBig', e.target.checked); if (state.settings.ptMode === 'dense') rebuildPoints(); }; $$('#set-densify, #q-densify').forEach((el) => (el.onchange = (e) => { setSetting('densify', e.target.value); rebuildPoints(); })); $$('#set-ptmax, #q-ptmax').forEach((el) => (el.oninput = (e) => setSetting('ptMaxPx', +e.target.value))); $('#q-ptscale').oninput = (e) => setSetting('ptScale', +e.target.value); $('#q-ptpx').oninput = (e) => setSetting('ptSize', +e.target.value); $('#set-hidebig').onchange = (e) => setSetting('hideBig', e.target.checked); $('#set-ptscale').oninput = (e) => setSetting('ptScale', +e.target.value); $('#set-cloudcolor').onchange = (e) => { setSetting('cloudColor', e.target.value); rebuildPoints(); }; $('#set-pick-splat').onchange = (e) => setSetting('pickSplat', e.target.checked); $$('input[name=pickmode]').forEach((r) => (r.onchange = (e) => setSetting('pickMode', e.target.value))); $('#set-pickr').oninput = (e) => setSetting('pickRadius', +e.target.value); $('#btn-pick-help').onclick = openPickHelp;
$('#btn-view').onclick = (e) => { e.stopPropagation(); $('#btn-view').parentElement.classList.toggle('open'); }; document.addEventListener('click', () => $('#btn-view').parentElement.classList.remove('open')); $$('#menu-view button').forEach((b) => (b.onclick = () => { setSetting('viewMode', b.dataset.view); applyViewMode(); })); $('#set-navstep').onchange = (e) => setSetting('navStep', Math.max(1, Math.min(90, +e.target.value || 15))); $('#btn-navpad').onclick = () => setSetting('navpad', !state.settings.navpad);
initNavpad();
$$('#live-rotpat, #set-rotpat').forEach((el) => (el.onchange = (e) => setSetting('rotPattern', e.target.value))); $$('#live-rotaxis, #set-rotaxis').forEach((el) => (el.onchange = (e) => setSetting('rotAxis', e.target.value))); $$('#live-rotstep, #set-rotstep').forEach((el) => (el.onchange = (e) => setSetting('rotStep', Math.max(0, Math.min(180, +e.target.value || 0))))); $('#set-hires').onchange = (e) => { state.loupeHiResFailed = false; setSetting('loupeHiRes', e.target.checked); }; $('#btn-undo').onclick = undoRay; $('#btn-worst').onclick = removeWorst; $('#btn-finish').onclick = () => finishPoint(); $('#btn-cancel').onclick = () => { if (state.rays.length) { cancelPoint(); toast('현재 점 측정을 취소했습니다.', 'info', 3000); } else endTask(); };
$('#ray-table').addEventListener('click', (e) => { if (e.target.closest('[data-undo]')) undoRay(); });
$('#pt-table').addEventListener('change', (e) => { const cb = e.target.closest('[data-sel]'); if (!cb) return; const id = +cb.dataset.sel; if (cb.checked) { if (state.selected.size >= 2) { const first = [...state.selected][0]; state.selected.delete(first); } state.selected.add(id); } else state.selected.delete(id); renderResults(); });
$('#pt-table').addEventListener('click', (e) => { const rf = e.target.closest('[data-refine]'); if (rf) { startRefine(+rf.dataset.refine); return; } const d = e.target.closest('[data-del]'); if (!d) return; const id = +d.dataset.del; state.points = state.points.filter((p) => p.id !== id); state.dists = state.dists.filter((x) => x.a !== id && x.b !== id); state.geoms = state.geoms.filter((g) => !g.ptIds.includes(id)); state.selected.delete(id); renderResults(); });
$('#dist-table').addEventListener('click', (e) => { const d = e.target.closest('[data-ddel]'); if (!d) return; state.dists.splice(+d.dataset.ddel, 1); renderResults(); });
$('#geom-table').addEventListener('click', (e) => { const d = e.target.closest('[data-gdel]'); if (!d) return; state.geoms.splice(+d.dataset.gdel, 1); renderResults(); });
$('#btn-geom-finish').onclick = finishGeometry;
$('#btn-analyze').onclick = (e) => { e.stopPropagation(); $('#btn-analyze').parentElement.classList.toggle('open'); };
document.addEventListener('click', () => $('#btn-analyze').parentElement.classList.remove('open'));
$$('#menu-analyze button').forEach((b) => (b.onclick = () => { const k = b.dataset.an; if (state.task?.kind === k) endTask(); else startTask(k); }));
$('#btn-dist-sel').onclick = () => { const [a, b] = [...state.selected].map((id) => state.points.find((p) => p.id === id)); if (a && b) { addDistance(a, b); state.selected.clear(); renderResults(); } };
$('#btn-clear').onclick = () => { if (!state.points.length || confirm('측정한 점과 거리를 모두 지울까요?')) { state.points = []; state.dists = []; state.geoms = []; state.selected.clear(); renderResults(); } };
// 설정 (변경 시 브라우저에 저장, 다음 방문에 복원)
function saveSettings() { try { state.settings.v = 2; localStorage.setItem('gsm.settings', JSON.stringify(state.settings)); } catch (_) {} }
function setSetting(key, val) { state.settings[key] = val; syncSettingsUI(); saveSettings(); if (state.task) updateMeasureUI(); }
function syncSettingsUI() {
  const st = state.settings;
  $('#set-n').value = st.n; $('#set-snap').checked = st.snap; $('#set-refine').checked = st.refine; $('#set-loupe').checked = st.loupe; $('#set-labels').checked = st.labels; st.zoom = Math.max(2, Math.min(5, Math.round(st.zoom * 2) / 2)); $('#set-zoom').value = st.zoom; $('#zoom-label').textContent = `${st.zoom}×`; $('#live-zoom').value = String(st.zoom); $('#set-dunit').value = st.dunit;
  $('#set-hires').checked = st.loupeHiRes; $('#set-autorot').checked = st.autoRotate;
  $('#set-navpad').checked = st.navpad; $('#set-navstep').value = st.navStep;
  $('#set-ptsize').value = st.ptSize; $('#ptsize-label').textContent = `${st.ptSize} px`; $('#set-ptmode').value = st.ptMode; $('#q-ptmode').value = st.ptMode; $$('#set-densify, #q-densify').forEach((el) => (el.value = String(st.densify))); $('#q-ptpx').value = st.ptSize; $('#q-ptpx-label').textContent = `${st.ptSize} px`; $('#row-dense-q').hidden = st.ptMode !== 'dense'; $('#row-gauss-q').hidden = st.ptMode !== 'gauss'; $('#row-gauss-q2').hidden = st.ptMode !== 'gauss'; $('#row-px-q').hidden = st.ptMode === 'gauss'; updateDenseLabel(); $('#set-hidebig').checked = st.hideBig; $('#set-ptscale').value = st.ptScale; $('#q-ptscale').value = st.ptScale; $$('#set-ptmax, #q-ptmax').forEach((el) => (el.value = st.ptMaxPx)); $$('#ptmax-label, #q-ptmax-label').forEach((el) => (el.textContent = `${st.ptMaxPx} px`)); $('#q-ptscale-label').textContent = `${st.ptScale}×`; $('#cloud-quick').hidden = !(st.viewMode !== 'splat' && state.points3); $('#ptscale-label').textContent = `${st.ptScale}×`; $('#row-ptsize').style.opacity = st.ptMode === 'gauss' ? '.55' : '1'; $('#row-ptscale').style.opacity = st.ptMode === 'gauss' ? '1' : '.55'; $('#set-cloudcolor').value = st.cloudColor; $('#set-pick-splat').checked = st.pickSplat; $$('input[name=pickmode]').forEach((r) => (r.checked = r.value === st.pickMode)); $('#opt-cluster').classList.toggle('on', st.pickMode === 'cluster'); $('#opt-nearest').classList.toggle('on', st.pickMode === 'nearest'); $('#set-pickr').value = st.pickRadius; $('#pickr-label').textContent = `${st.pickRadius} px`; $('#navpad').hidden = !(st.navpad && state.mesh); $('#btn-navpad').classList.toggle('active', st.navpad);
  $$('#live-loupe-size button, #set-loupe-size button').forEach((b) => b.classList.toggle('on', b.dataset.ls === st.loupeSize));
  const t = $('#live-autorot'); t.textContent = st.autoRotate ? '켬' : '끔'; t.classList.toggle('on', st.autoRotate);
  $$('#live-rotpat, #set-rotpat').forEach((el) => (el.value = st.rotPattern)); $$('#live-rotaxis, #set-rotaxis').forEach((el) => (el.value = st.rotAxis)); $$('#live-rotstep, #set-rotstep').forEach((el) => { el.value = st.rotStep > 0 ? st.rotStep : ''; el.placeholder = `자동 ${autoStepDeg().toFixed(0)}°`; });
  $('#btn-autorot').title = `측정 중인 점을 중심으로 ${autoStepDeg().toFixed(0)}° 더 돌립니다 (R)`;
}
try { const saved = JSON.parse(localStorage.getItem('gsm.settings') || 'null'); if (saved && typeof saved === 'object') { Object.assign(state.settings, saved); if (!saved.v || saved.v < 2) { state.settings.zoom = 2; state.settings.v = 2; } } } catch (_) {}
$('#set-n').onchange = (e) => { setSetting('n', Math.max(2, Math.min(12, +e.target.value || 5))); };
$('#set-snap').onchange = (e) => setSetting('snap', e.target.checked); $('#set-refine').onchange = (e) => setSetting('refine', e.target.checked); $('#set-loupe').onchange = (e) => setSetting('loupe', e.target.checked); $('#set-labels').onchange = (e) => setSetting('labels', e.target.checked);
$('#set-zoom').oninput = (e) => setSetting('zoom', +e.target.value); $('#live-zoom').onchange = (e) => setSetting('zoom', +e.target.value); $('#set-dunit').onchange = (e) => { setSetting('dunit', e.target.value); renderResults(); };
syncSettingsUI();
// 드롭
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); if (state.mesh) dz.classList.remove('hidden'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); if (state.mesh) dz.classList.add('hidden'); }));
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });
// 포인터 (클릭 vs 드래그 구분)
let down = null;
document.addEventListener('pointerdown', (e) => { if (e.target !== renderer?.domElement || e.button !== 0) return; down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
// 클릭 vs 드래그는 이동 거리로만 판정 (느린 렌더링 중 길게 눌러도 클릭으로 인정)
document.addEventListener('pointerup', (e) => { if (!down || e.button !== 0) return; const mv = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t; down = null; if (mv < 5 && state.task && e.target === renderer.domElement) { const r = renderer.domElement.getBoundingClientRect(); state.forceRay = e.shiftKey; onMeasureClick(e.clientX - r.left, e.clientY - r.top); state.forceRay = false; } });
document.addEventListener('pointermove', (e) => { if (!renderer) return; const r = renderer.domElement.getBoundingClientRect(); state.mouse.x = e.clientX - r.left; state.mouse.y = e.clientY - r.top; state.mouse.inside = e.target === renderer.domElement; });
// 키
document.addEventListener('keydown', (e) => { if (e.target.matches('input,select,textarea')) return; if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; } const k = e.key.toLowerCase(); if (e.key === 'Tab' && state.mesh) { e.preventDefault(); setSetting('viewMode', state.settings.viewMode === 'splat' ? 'cloud' : 'splat'); applyViewMode(); toast(`보기: <b>${state.settings.viewMode === 'cloud' ? '점군 — 클릭 한 번으로 점 선택(직접선택)' : '스플랫 — 다시점 클릭 측정'}</b>`, 'info', 2500); return; } if (k === 'm') $('#btn-point').click(); else if (k === 'd') $('#btn-dist').click(); else if (k === 'r') autoRotate(); else if (k === 'h') frameAll(); else if (k === 'f') { const rp = refPoint(); if (rp) moveTarget(rp); } else if (k === 'a' && !e.ctrlKey && !e.metaKey) $$('#menu-analyze button')[0].click(); else if (k === 'l') $$('#menu-analyze button')[1].click(); else if (k === 'p') $$('#menu-analyze button')[2].click(); else if (e.key === 'Enter') { if (state.task && GEOM_NEED[state.task.kind] && state.rays.length === 0) finishGeometry(); else finishPoint(); } else if (e.key === 'Escape') $('#btn-cancel').click(); else if (e.key === 'Backspace') { e.preventDefault(); undoRay(); } else if (e.key === '?') openHelp(); else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && state.task && state.rays.length) { e.preventDefault(); const st = autoStepDeg(); if (e.key === 'ArrowRight') autoOrbit(st, 'h'); else if (e.key === 'ArrowLeft') autoOrbit(-st, 'h'); else if (e.key === 'ArrowUp') autoOrbit(Math.min(st, 45), 'v'); else autoOrbit(-Math.min(st, 45), 'v'); } else if ((e.key === '-' || e.key === '=' || e.key === '+') && state.points3 && state.settings.viewMode !== 'splat') { const d = e.key === '-' ? -1 : 1; if (state.settings.ptMode === 'gauss') { setSetting('ptMaxPx', Math.max(1, Math.min(24, state.settings.ptMaxPx + d))); toast(`점군 최대 점 크기 ${state.settings.ptMaxPx} px`, 'info', 1200); } else { setSetting('ptSize', Math.max(0.5, Math.min(6, +(state.settings.ptSize + 0.5 * d).toFixed(1)))); toast(`점군 점 크기 ${state.settings.ptSize} px`, 'info', 1200); } } else if (e.key === '[' || e.key === ']') setSetting('zoom', Math.max(2, Math.min(5, state.settings.zoom + (e.key === ']' ? 0.5 : -0.5)))); });
function resetAll(keepFile) { state.points = []; state.dists = []; state.geoms = []; state.selected.clear(); state.nextId = 1; state.task = null; cancelPoint(false); $$('#btn-point,#btn-dist').forEach((b) => b.classList.remove('active')); $('#measure-idle').hidden = false; $('#measure-live').hidden = true; renderResults(); }
function runTour() { document.getElementById('app').classList.add('tour-active'); startTour(TOUR_STEPS, { onDone: () => { document.getElementById('app').classList.remove('tour-active'); try { localStorage.setItem('gsm.tourSeen', '1'); } catch (_) {} } }); }

// ------------------------------------------------------------------ 시작
if (initGL()) {
  coach('', '3DGS 파일을 열어 시작하세요. 처음이라면 <b>기능 소개 투어</b>를 눌러 보세요.');
  if (FILE_MODE) { $('#btn-sample').hidden = true; $('#drop-sample').hidden = true; const n = document.createElement('p'); n.className = 'muted small'; n.textContent = '파일에서 직접 열린 단일 파일 버전입니다. 내 3DGS 파일을 끌어다 놓거나 [파일 선택]을 누르세요. (샘플 체험은 온라인 버전에서만 제공)'; $('.drop-actions').after(n); }
  let seen = false; try { seen = !!localStorage.getItem('gsm.tourSeen'); } catch (_) {}
  if (!seen && !location.hash.includes('notour')) setTimeout(runTour, 600);
}

// ------------------------------------------------------------------ 테스트/자동화용 API
window.__app = {
  state, THREE, camera, controls, get renderer() { return renderer; },
  async loadArrayBuffer(name, buf, sidecarText) { const files = [new File([buf], name)]; if (sidecarText) files.push(new File([sidecarText], name + '.json')); await loadFiles(files); },
  setCamera(pos, target, up) { if (up) camera.up.set(...up); camera.position.set(...pos); controls.target.set(...target); controls.update(); renderer.render(scene, camera); },
  project(p) { return project(new THREE.Vector3(...p)); },
  click(px, py) { onMeasureClick(px, py); },
  startTask, finishPoint, endTask, frameAll, autoRotate, autoOrbit, origCoord, navAction, directPick, rebuildPoints, addPickedPoint, applyViewMode, startRefine, geomInfo, addGeom, distanceDecomp, finishGeometry, taskPointAdded, propagate, navOrbit, navPan, navZoom, similarityFromPairs, toReal, get animating() { return anims.length > 0; },
  debugAddPoint(xyz, name) { const p = { id: state.nextId++, name: name || `P${state.nextId - 1}`, p: new THREE.Vector3(...xyz), sigma0: 1e-4, cov: new THREE.Matrix3().identity().multiplyScalar(1e-8), n: 5, quality: 'good', pxRms: 0.1, maxAngleDeg: 60, rays: [] }; state.points.push(p); renderResults(); return p; },
  openGcpCalib, setGcp(name, xyz) { state.gcpInputs[name] = { x: xyz[0], y: xyz[1], z: xyz[2] }; }, openChecklist, openCalibWizard, applyManualScale(s) { state.unit = { known: true, factor: s, sigmaRel: 0, source: 'test' }; applyUnitUI(); },
  distanceInfo, intersectRays, render() { renderer.render(scene, camera); drawOverlay(); },
  pixel(px, py) { const g = grabGray(px, py, 3); const r = glRatio(); scratch.width = 1; scratch.height = 1; sctx.drawImage(renderer.domElement, px * r, py * r, 1, 1, 0, 0, 1, 1); return Array.from(sctx.getImageData(0, 0, 1, 1).data); },
};
