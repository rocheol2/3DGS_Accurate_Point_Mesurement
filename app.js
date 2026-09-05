// 3DGS 다시점 거리 측정기 — Deng & Qin (2026) 다시점 공간교회(spatial intersection)를 브라우저에서 구현
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { ERRORS, QUALITY } from './errors.js';
import { startTour, TOUR_STEPS } from './tour.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ 상태
const state = {
  file: null, header: null, mesh: null, bounds: null,
  unit: { known: false, factor: 1, sigmaRel: 0, source: '' },
  upSource: null,
  task: null,            // {kind:'point'|'distance'|'calib', pts:[], trueLen?}
  rays: [], estimate: null, refPatch: null, autoRotCount: 0,
  points: [], dists: [], selected: new Set(), nextId: 1,
  settings: { n: 5, snap: true, refine: true, loupe: true, zoom: 4, dunit: 'auto', labels: true },
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
function loop() {
  requestAnimationFrame(loop);
  tickAnimations();
  controls.update();
  if (state.mesh) renderer.render(scene, camera);
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
  camera.near = Math.max(1e-4, radius * 0.001); camera.far = radius * 200; camera.updateProjectionMatrix();
  controls.update();
}
function setUp(v, source) {
  camera.up.copy(v).normalize(); state.upSource = source;
  const names = { '0,-1,0': '−Y', '0,1,0': '+Y', '0,0,1': '+Z', '0,0,-1': '−Z', '1,0,0': '+X', '-1,0,0': '−X' };
  $('#up-label').textContent = names[[v.x, v.y, v.z].join(',')] || '사용자';
  if (state.bounds) frameAll();
}
function autoRotate(dAzDeg = 35) {
  if (!state.task) return;
  const center = refPoint(); if (!center) return;
  const up = camera.up.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0)); const qi = q.clone().invert();
  const off0 = camera.position.clone().sub(center).applyQuaternion(q);
  const sph0 = new THREE.Spherical().setFromVector3(off0);
  const sign = (state.autoRotCount++ % 2 === 0) ? 1 : -1;
  const sph1 = sph0.clone(); sph1.theta += dAzDeg * DEG * (state.autoRotCount % 4 < 2 ? 1 : -1);
  sph1.phi = THREE.MathUtils.clamp(sph0.phi + sign * 12 * DEG, 0.15, Math.PI - 0.15);
  const tFrom = controls.target.clone();
  animate(650, (e) => {
    const s = new THREE.Spherical(sph0.radius, sph0.phi + (sph1.phi - sph0.phi) * e, sph0.theta + (sph1.theta - sph0.theta) * e);
    camera.position.copy(center).add(new THREE.Vector3().setFromSpherical(s).applyQuaternion(qi));
    controls.target.lerpVectors(tFrom, center, e);
  });
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
function fmtCoord(p) { const f = state.unit.known ? state.unit.factor : 1; const u = state.unit.known ? 'm' : 'u'; return `(${(p.x * f).toFixed(3)}, ${(p.y * f).toFixed(3)}, ${(p.z * f).toFixed(3)}) ${u}`; }

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
  $('#loading').hidden = false; $('#loading-text').textContent = `파일을 읽는 중… (${main.name}, ${(main.size / 1e6).toFixed(1)} MB)`; $('#loading-sub').textContent = '';
  await new Promise((r) => setTimeout(r, 30));
  let buf; try { buf = await main.arrayBuffer(); } catch (e) { $('#loading').hidden = true; showError('E11', String(e)); return; }
  let header = null;
  if (ext === 'ply') {
    header = parsePlyHeader(buf);
    if (!header) { $('#loading').hidden = true; showError('E02', 'PLY 헤더를 읽을 수 없습니다(손상 또는 텍스트 형식).'); return; }
    if (header.is2dgs) { $('#loading').hidden = true; showError('E04'); return; }
    if (!header.has3dgs) { $('#loading').hidden = true; showError('E03', `속성: ${header.names.slice(0, 8).join(', ')}${header.names.length > 8 ? ' …' : ''}`); return; }
    if (header.count > 6e6) showError('E13', `가우시안 ${header.count.toLocaleString()}개`);
    $('#loading-sub').textContent = `가우시안 ${header.count.toLocaleString()}개 · SH ${header.shDegree}차 · ${header.compressed ? '압축 PLY' : '3DGS PLY'} — GPU에 올리는 중`;
  }
  // 이전 모델 제거
  if (state.mesh) { scene.remove(state.mesh); try { state.mesh.dispose?.(); } catch (_) {} state.mesh = null; }
  resetAll(true);
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
  // 위 방향
  const upFromHeader = header?.upAxis ? { '+z': [0, 0, 1], '-z': [0, 0, -1], '+y': [0, 1, 0], '-y': [0, -1, 0], '+x': [1, 0, 0], '-x': [-1, 0, 0] }[header.upAxis] : null;
  if (upFromHeader) setUp(new THREE.Vector3(...upFromHeader), 'PLY 헤더(up axis)');
  else { setUp(new THREE.Vector3(...(ext === 'spz' ? [0, 1, 0] : [0, -1, 0])), null); showError('E06', `현재 가정: ${ext === 'spz' ? '+Y (SPZ 관례)' : '−Y (COLMAP 3DGS 관례)'}`); }
  frameAll();
  // 단위
  let sidecar = null; if (side) { try { sidecar = JSON.parse(await side.text()); } catch (e) { showError('E12', `JSON 구문 오류: ${String(e).slice(0, 80)}`); } }
  resolveUnits(header, sidecar);
  // UI
  $('#loading').hidden = true; $('#dropzone').classList.add('hidden');
  ['#btn-point', '#btn-dist', '#btn-scale', '#btn-export', '#btn-up', '#btn-home'].forEach((s) => ($(s).disabled = false));
  glHost.classList.remove('measuring');
  coach('', `<b>${main.name}</b> 열림 (가우시안 ${state.file.count ? state.file.count.toLocaleString() : '?'}개). <b>● 점 측정</b> 또는 <b>↔ 거리 측정</b>을 누르고, 휠로 잴 곳을 확대하세요.`);
  updateCheckDot(); renderResults();
}
function fileKey() { return state.file ? `gsm.calib:${state.file.name}:${state.file.size}` : null; }
function resolveUnits(header, sidecar) {
  const u = { known: false, factor: 1, sigmaRel: 0, source: '' };
  const saved = fileKey() && localStorage.getItem(fileKey());
  if (sidecar) {
    if (typeof sidecar.scale_to_meters === 'number' && sidecar.scale_to_meters > 0) Object.assign(u, { known: true, factor: sidecar.scale_to_meters, sigmaRel: sidecar.scale_sigma_rel || 0, source: `사이드카 JSON (scale_to_meters=${sidecar.scale_to_meters})` });
    else if (/^m(eters?|etres?)?$/i.test(String(sidecar.units || '')) || /meters/i.test(String(sidecar.ply_axes || ''))) Object.assign(u, { known: true, factor: 1, sigmaRel: sidecar.residual_rms_m && sidecar.n_gps_used ? 0.02 : 0, source: sidecar.mode === 'from-gps' ? `사이드카 JSON (gs_ply_georef from-gps, 축척 ${Number(sidecar.scale).toFixed(4)} 적용됨)` : '사이드카 JSON (units: m)' });
    else showError('E12', `키: ${Object.keys(sidecar).slice(0, 6).join(', ')}`);
  }
  if (!u.known && saved) { try { const s = JSON.parse(saved); Object.assign(u, { known: true, factor: s.factor, sigmaRel: s.sigmaRel || 0, source: `이전 축척 보정값 (저장됨, ${new Date(s.when).toLocaleDateString()})` }); } catch (_) {} }
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
  if (kind === 'point') $('#btn-point').classList.add('active'); if (kind === 'distance') $('#btn-dist').classList.add('active');
  glHost.classList.add('measuring'); showTab('measure'); $('#measure-idle').hidden = true; $('#measure-live').hidden = false;
  updateMeasureUI();
}
function taskLabel() {
  const t = state.task; if (!t) return '';
  if (t.kind === 'point') return `점 측정 (P${state.nextId})`;
  if (t.kind === 'distance') return `거리 측정 — ${t.pts.length === 0 ? 'A점' : 'B점'}`;
  if (t.kind === 'calib') return `축척 보정 — ${t.pts.length === 0 ? '기준 구간 A점' : '기준 구간 B점'}`;
  return '';
}
function endTask() {
  state.task = null; cancelPoint(false);
  $$('#btn-point,#btn-dist').forEach((b) => b.classList.remove('active'));
  glHost.classList.remove('measuring'); $('#measure-idle').hidden = false; $('#measure-live').hidden = true; $('#loupe').hidden = true;
  coach('', state.mesh ? '<b>● 점 측정</b> 또는 <b>↔ 거리 측정</b>을 눌러 시작하세요.' : '3DGS 파일을 열어 시작하세요.');
}
function cancelPoint(ui = true) { state.rays = []; state.estimate = null; state.refPatch = null; state.autoRotCount = 0; if (ui) updateMeasureUI(); }
function onMeasureClick(px, py) {
  if (!state.task || !state.mesh) return;
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
  if (state.rays.length === 1) { const rp = refPoint(); if (rp) moveTarget(rp, 350); }
  else if (state.estimate) { moveTarget(state.estimate.p, 350); }
  updateMeasureUI();
  if (state.rays.length >= state.settings.n) finishPoint();
}
function recompute() { state.estimate = state.rays.length >= 2 ? intersectRays(state.rays) : null; }
function finishPoint(force = false) {
  if (!state.task) return;
  if (state.rays.length < 2) { showError('E07', `현재 광선 ${state.rays.length}개`); return; }
  const e = state.estimate; if (!e) { showError('E07'); return; }
  if (e.maxAngleDeg < 10 && !force) { showError('E08', `현재 최대 각도 ${e.maxAngleDeg.toFixed(1)}°`, { actions: '<div class="btnrow"><button class="btn small" data-act="force">그래도 확정(비권장)</button><button class="btn small" data-act="undo">마지막 광선 취소</button></div>', onAction: (a) => { if (a === 'force') finishPoint(true); if (a === 'undo') undoRay(); } }); return; }
  if (e.pxRms > 4) showError('E09', `잔차 RMS ${e.pxRms.toFixed(1)} px, σ₀ = ${fmtLen(e.sigma0)}`);
  const pt = { id: state.nextId++, name: `P${state.nextId - 1}`, p: e.p.clone(), sigma0: e.sigma0, cov: e.cov.clone(), n: e.n, quality: e.quality, pxRms: e.pxRms, maxAngleDeg: e.maxAngleDeg, rays: state.rays.map((r) => ({ o: r.o.toArray(), d: r.d.toArray(), screen: r.screen, note: r.note })) };
  state.points.push(pt);
  const t = state.task; t.pts.push(pt);
  toast(`<b>${pt.name} 확정</b> ${fmtCoord(pt.p)} · σ₀ ${fmtLen(pt.sigma0)} · 품질 <span class="badge ${pt.quality}">${QUALITY[pt.quality].label}</span>`, pt.quality === 'poor' ? 'warn' : 'good', 6000);
  cancelPoint(false);
  if (t.kind === 'point') { updateMeasureUI(); }
  else if (t.kind === 'distance') { if (t.pts.length === 2) { addDistance(t.pts[0], t.pts[1]); endTask(); } else updateMeasureUI(); }
  else if (t.kind === 'calib') { if (t.pts.length === 2) { const di = distanceInfo(t.pts[0], t.pts[1]); endTask(); openCalibResult(t, di); } else updateMeasureUI(); }
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
const loupe = $('#loupe'), lctx = $('#loupe-canvas').getContext('2d');
function updateLoupe() {
  const show = state.task && state.settings.loupe && state.mouse.inside && state.mesh && !anims.length;
  loupe.hidden = !show; if (!show) return;
  const z = state.settings.zoom, L = 180, src = L / z, r = glRatio(); const { x, y } = state.mouse; const { w, h } = viewSize();
  let lx = x + 28, ly = y - L - 28; if (lx + L > w - 4) lx = x - L - 28; if (ly < 4) ly = y + 28;
  loupe.style.left = lx + 'px'; loupe.style.top = (ly + parseInt(getComputedStyle(document.documentElement).getPropertyValue('--top-h'))) + 'px';
  lctx.imageSmoothingEnabled = false; lctx.fillStyle = '#000'; lctx.fillRect(0, 0, L, L);
  try { lctx.drawImage(renderer.domElement, (x - src / 2) * r, (y - src / 2) * r, src * r, src * r, 0, 0, L, L); } catch (_) {}
  const T = (p) => ({ x: (p.x - x) * z + L / 2, y: (p.y - y) * z + L / 2 });
  if (state.rays.length) { const line = epipolarPolyline(state.rays[0]); lctx.strokeStyle = '#fbbf24'; lctx.lineWidth = 2; lctx.setLineDash([8, 6]); lctx.beginPath(); let pen = false; for (let i = 0; i < line.length; i++) { const p = line[i]; if (!p.front) { pen = false; continue; } const q = T(p); if (!pen) { lctx.moveTo(q.x, q.y); pen = true; } else lctx.lineTo(q.x, q.y); } lctx.stroke(); lctx.setLineDash([]); }
  if (state.estimate) { const q = T(project(state.estimate.p)); lctx.strokeStyle = '#22d3ee'; lctx.lineWidth = 2; lctx.beginPath(); lctx.arc(q.x, q.y, 8 * z / 2, 0, Math.PI * 2); lctx.stroke(); }
  lctx.strokeStyle = '#22d3ee'; lctx.lineWidth = 1; lctx.beginPath(); lctx.moveTo(L / 2, 0); lctx.lineTo(L / 2, L); lctx.moveTo(0, L / 2); lctx.lineTo(L, L / 2); lctx.stroke();
  lctx.strokeStyle = '#fff'; lctx.beginPath(); lctx.arc(L / 2, L / 2, 6, 0, Math.PI * 2); lctx.stroke();
  $('#loupe-info').textContent = `${z}× · 광선 ${state.rays.length}/${state.settings.n}`;
}

// ------------------------------------------------------------------ 오버레이
function drawOverlay() {
  const { w, h } = viewSize(); octx.clearRect(0, 0, w, h); if (!state.mesh) return;
  const ctx = octx;
  // 측정된 점 · 거리
  if (state.settings.labels) {
    for (const d of state.dists) { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); if (!a || !b) continue; const pa = project(a.p), pb = project(b.p); if (!pa.front || !pb.front) continue; ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke(); const di = distanceInfo(a, b); pill(ctx, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 14, `${a.name}–${b.name}  ${fmtLen(di.d, di.sigma, true)}${state.unit.known ? '' : ' ⚠'}`, '#22d3ee'); }
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
  const step = `${Math.min(n + 1, N)}/${N}`; const lab = taskLabel();
  if (n === 0) coach(step, `<b>${lab}</b> — 잴 점을 <b>휠로 크게 확대</b>한 뒤 정확히 클릭하세요. (확대창이 커서 옆에 뜹니다)`, '오른쪽 드래그: 이동 · 왼쪽 드래그: 회전');
  else if (n === 1) coach(step, `<b>${lab}</b> — 카메라를 <b>20° 이상 돌린 뒤</b>(왼쪽 드래그 또는 <b>R</b> 자동 회전) 노란 <b>안내선 위</b>에서 같은 점을 클릭하세요.`, '');
  else coach(step, `<b>${lab}</b> — 또 다른 각도에서 같은 점(청록 원 근처)을 클릭하세요. ${N - n}개 남음 · 지금 확정: <b>Enter</b>`, e ? `σ₀ ${fmtLen(e.sigma0)} · 최대각 ${e.maxAngleDeg.toFixed(0)}°` : '');
}
function tickAngleMeter() { if (!state.task || !state.rays.length) return; const a = currentAngleDeg(); const f = $('#angle-fill'); f.style.width = `${Math.min(100, a / 40 * 100)}%`; f.classList.toggle('ok', a >= 20); $('#angle-text').textContent = a >= 20 ? `현재 각도 ${a.toFixed(0)}° — 충분합니다. 같은 점을 클릭하세요` : `현재 각도 ${a.toFixed(0)}° — 카메라를 더 돌리세요 (20° 이상 권장)`; }
setInterval(tickAngleMeter, 120);

// ------------------------------------------------------------------ 결과 패널
function renderResults() {
  $('#results-count').textContent = state.points.length;
  const tb = $('#pt-table tbody'); tb.innerHTML = state.points.map((p) => `<tr class="${state.selected.has(p.id) ? 'sel' : ''}"><td><input type="checkbox" data-sel="${p.id}" ${state.selected.has(p.id) ? 'checked' : ''}></td><td><b>${p.name}</b> <span class="badge ${p.quality}" title="${QUALITY[p.quality].desc}">${QUALITY[p.quality].label}</span></td><td class="mono">${fmtCoord(p.p)}</td><td class="num">${fmtLen(p.sigma0)}</td><td class="num">${p.n}</td><td><button class="xbtn" data-del="${p.id}" title="삭제">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">아직 측정한 점이 없습니다.</td></tr>';
  const db = $('#dist-table tbody'); db.innerHTML = state.dists.map((d, i) => { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); if (!a || !b) return ''; const di = distanceInfo(a, b); return `<tr><td>${a.name}–${b.name}</td><td class="num"><b>${fmtLen(di.d)}</b>${state.unit.known ? '' : ' <span title="축척 정보 없음">⚠</span>'}</td><td class="num">${fmtLen(di.sigma, null).replace(/^/, '± ')}</td><td><button class="xbtn" data-ddel="${i}" title="삭제">✕</button></td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">거리 없음 — ↔ 거리 측정 또는 점 2개 체크 후 [선택 두 점 거리]</td></tr>';
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
  if (state.file) { if (state.unit.known) it('ok', '축척 (1 u → m)', `${state.unit.source} · 1 u = ${state.unit.factor.toPrecision(6)} m${state.unit.sigmaRel ? ` · 축척 상대 불확도 ≈ ${(state.unit.sigmaRel * 100).toFixed(1)} %` : ''}`); else it('warn', '축척 (1 u → m)', ERRORS.E05.why, ERRORS.E05.fix); it(state.upSource ? 'ok' : 'warn', '위(上) 방향', state.upSource ? `${state.upSource}: ${$('#up-label').textContent}` : `정보 없음 → ${$('#up-label').textContent} 가정 (측정 정확도 무관)`, state.upSource ? '' : ERRORS.E06.fix); }
  if (state.task) { const n = state.rays.length, e = state.estimate; if (n < 2) it('bad', '진행 중 측정: 광선 수', `${n}개 — ${ERRORS.E07.why}`, ERRORS.E07.fix); else { it(e.maxAngleDeg >= 20 ? 'ok' : e.maxAngleDeg >= 10 ? 'warn' : 'bad', '진행 중 측정: 광선 각도', `최대 ${e.maxAngleDeg.toFixed(1)}° (20° 이상 권장)`, e.maxAngleDeg < 20 ? ERRORS.E08.fix : ''); it(e.pxRms <= 1.5 ? 'ok' : e.pxRms <= 4 ? 'warn' : 'bad', '진행 중 측정: 광선 잔차', `RMS ${e.pxRms.toFixed(1)} px · σ₀ ${fmtLen(e.sigma0)}`, e.pxRms > 4 ? ERRORS.E09.fix : ''); } }
  it(state.points.length ? 'ok' : 'na', '결과', `점 ${state.points.length}개 · 거리 ${state.dists.length}개${state.points.length && !state.unit.known ? ' · ⚠ 모두 모델 단위' : ''}`);
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
  openModal(`<h2>축척 보정</h2><div class="wizard-steps"><span class="done"></span><span></span><span></span></div>
  <p><b>1단계.</b> 실제 길이를 <b>정확히 아는 구간</b>을 정합니다. 예: A4 용지 긴 변 <b>297 mm</b>, 줌자로 잰 문 폭, 두 측량 기준점 사이 거리, 레이저 스캐너 자료에서 잰 길이. 길수록(수 m) 축척이 정확해집니다.</p>
  <div class="form-row"><label>참값(실제 길이)</label><input id="cal-val" type="number" step="any" min="0" placeholder="예: 297"><select id="cal-unit"><option value="mm">mm</option><option value="cm">cm</option><option value="m" selected>m</option></select><input id="cal-desc" type="text" placeholder="설명(선택): 예) 1층 출입문 폭" style="flex:1;min-width:160px"></div>
  <p class="muted small">2단계에서 그 구간의 <b>양 끝점</b>을 보통 점 측정과 똑같이(각 5회 클릭) 잽니다. 3단계에서 축척계수 = 참값 ÷ 측정값 을 계산해 적용합니다.</p>
  <div class="btnrow"><button class="btn primary" id="cal-start">2단계: 양 끝점 측정 시작</button><button class="btn ghost" id="cal-manual">축척을 이미 알면 직접 입력</button></div>`);
  $('#cal-start').onclick = () => { const v = parseFloat($('#cal-val').value); const u = $('#cal-unit').value; if (!(v > 0)) { showError('E10', '참값을 먼저 입력하세요.'); return; } const trueLen = v * (u === 'mm' ? 0.001 : u === 'cm' ? 0.01 : 1); closeModal(); startTask('calib', { trueLen, desc: $('#cal-desc').value }); toast(`<b>축척 보정 2단계</b> 참값 ${trueLen} m 구간의 <b>A점</b>을 재세요 (5회 클릭)`, 'info', 6000); };
  $('#cal-manual').onclick = openManualScale;
}
function openCalibResult(t, di) {
  if (!(di.d > 1e-9) || !(t.trueLen > 0)) { showError('E10', `측정 거리 ${di.d}`); return; }
  const s = t.trueLen / di.d; const rel = di.sigma / di.d;
  openModal(`<h2>축척 보정 결과</h2><div class="wizard-steps"><span class="done"></span><span class="done"></span><span class="done"></span></div>
  <div class="kv"><span>측정 거리 (모델 단위)</span><b>${di.d.toFixed(5)} u ± ${di.sigma.toFixed(5)}</b><span>참값</span><b>${t.trueLen} m ${t.desc ? `(${t.desc})` : ''}</b><span>축척계수 s = 참값 ÷ 측정</span><b class="bigval">1 u = ${s.toPrecision(6)} m</b><span>축척 상대 불확도</span><b>≈ ${(rel * 100).toFixed(2)} %</b></div>
  <p class="muted small">적용하면 모든 점 좌표·거리가 미터로 표시되고, 이 파일(이름+크기)에 대해 브라우저에 저장되어 다음에 다시 열 때 자동 적용됩니다. 다른 컴퓨터에서도 쓰려면 사이드카 JSON을 내려받아 파일 옆에 두세요.</p>
  <div class="btnrow"><button class="btn primary" id="cal-apply">적용</button><button class="btn" id="cal-json">적용 + 사이드카 JSON 저장</button><button class="btn ghost" id="cal-cancel">취소</button></div>`);
  const apply = () => { state.unit = { known: true, factor: s, sigmaRel: rel, source: `축척 보정 (참값 ${t.trueLen} m${t.desc ? ', ' + t.desc : ''})` }; try { localStorage.setItem(fileKey(), JSON.stringify({ factor: s, sigmaRel: rel, when: Date.now(), trueLen: t.trueLen, desc: t.desc })); } catch (_) {} applyUnitUI(); toast(`<b>축척 적용</b> 1 u = ${s.toPrecision(6)} m — 이제 거리가 미터로 표시됩니다.`, 'good'); };
  $('#cal-apply').onclick = () => { apply(); closeModal(); };
  $('#cal-json').onclick = () => { apply(); download(`${state.file.name}.scale.json`, JSON.stringify({ units: 'model', scale_to_meters: s, scale_sigma_rel: rel, calibrated_with: { true_length_m: t.trueLen, measured_model_units: di.d, desc: t.desc }, file: { name: state.file.name, size: state.file.size }, generated_by: '3DGS 다시점 거리 측정기', when: new Date().toISOString() }, null, 2), 'application/json'); closeModal(); };
  $('#cal-cancel').onclick = closeModal;
}
function openManualScale() {
  openModal(`<h2>축척 직접 입력</h2><p>이 모델에서 <b>1 모델 단위가 실제로 몇 m</b>인지 아는 경우에만 사용하세요. (예: gs_ply_georef.py 가 출력한 축척, GCP 지오리퍼런싱의 Scale 값)</p><div class="form-row"><label>1 u =</label><input id="man-s" type="number" step="any" min="0" placeholder="예: 4.2015"><span>m</span><input id="man-src" type="text" placeholder="출처(선택)" style="flex:1;min-width:160px"></div><div class="btnrow"><button class="btn primary" id="man-apply">적용</button><button class="btn ghost" id="man-reset">축척 정보 지우기(모델 단위로)</button></div>`);
  $('#man-apply').onclick = () => { const s = parseFloat($('#man-s').value); if (!(s > 0)) { showError('E10', '축척은 0보다 큰 숫자여야 합니다.'); return; } state.unit = { known: true, factor: s, sigmaRel: 0, source: `직접 입력${$('#man-src').value ? ' (' + $('#man-src').value + ')' : ''}` }; try { localStorage.setItem(fileKey(), JSON.stringify({ factor: s, sigmaRel: 0, when: Date.now(), manual: true })); } catch (_) {} applyUnitUI(); closeModal(); };
  $('#man-reset').onclick = () => { try { localStorage.removeItem(fileKey()); } catch (_) {} state.unit = { known: false, factor: 1, sigmaRel: 0, source: '' }; applyUnitUI(); closeModal(); };
}
function openExport() {
  if (!state.points.length) { toast('내보낼 측정 결과가 없습니다. 먼저 점을 재세요.', 'warn'); return; }
  openModal(`<h2>내보내기</h2><p class="muted small">단위: ${state.unit.known ? `미터 (${state.unit.source})` : '<b>모델 단위(u)</b> — 축척 정보가 없어 미터 열은 비어 있습니다'}</p><div class="btnrow"><button class="btn primary" id="ex-csv">CSV (점 + 거리)</button><button class="btn" id="ex-json">JSON (공분산·광선 포함)</button><button class="btn" id="ex-png">PNG 스크린샷</button></div>`);
  $('#ex-csv').onclick = () => { const f = state.unit.known ? state.unit.factor : null; let csv = '﻿type,id,name,x_model,y_model,z_model,sigma0_model,x_m,y_m,z_m,sigma0_m,n_rays,quality,px_rms,max_angle_deg\n'; for (const p of state.points) csv += `point,${p.id},${p.name},${p.p.x},${p.p.y},${p.p.z},${p.sigma0},${f ? p.p.x * f : ''},${f ? p.p.y * f : ''},${f ? p.p.z * f : ''},${f ? p.sigma0 * f : ''},${p.n},${p.quality},${p.pxRms.toFixed(2)},${p.maxAngleDeg.toFixed(1)}\n`; csv += '\ntype,a,b,dist_model,sigma_model,dist_m,sigma_m,unit_source\n'; for (const d of state.dists) { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); if (!a || !b) continue; const di = distanceInfo(a, b); csv += `distance,${a.name},${b.name},${di.d},${di.sigma},${f ? di.d * f : ''},${f ? Math.sqrt((di.sigma * f) ** 2 + (di.d * f * state.unit.sigmaRel) ** 2) : ''},"${state.unit.known ? state.unit.source : '축척 정보 없음(모델 단위)'}"\n`; } download(`${state.file.name}.measurements.csv`, csv, 'text/csv'); };
  $('#ex-json').onclick = () => download(`${state.file.name}.measurements.json`, JSON.stringify({ file: state.file, unit: state.unit, up: $('#up-label').textContent, points: state.points.map((p) => ({ ...p, p: p.p.toArray(), cov: p.cov.toArray() })), distances: state.dists.map((d) => { const a = state.points.find((p) => p.id === d.a), b = state.points.find((p) => p.id === d.b); const di = a && b ? distanceInfo(a, b) : null; return { a: d.a, b: d.b, dist_model: di?.d, sigma_model: di?.sigma }; }), method: 'Deng & Qin 2026 multi-ray least-squares spatial intersection', when: new Date().toISOString() }, null, 2), 'application/json');
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
$('#btn-autorot').onclick = () => autoRotate(); $('#btn-undo').onclick = undoRay; $('#btn-worst').onclick = removeWorst; $('#btn-finish').onclick = () => finishPoint(); $('#btn-cancel').onclick = () => { if (state.rays.length) { cancelPoint(); toast('현재 점 측정을 취소했습니다.', 'info', 3000); } else endTask(); };
$('#ray-table').addEventListener('click', (e) => { if (e.target.closest('[data-undo]')) undoRay(); });
$('#pt-table').addEventListener('change', (e) => { const cb = e.target.closest('[data-sel]'); if (!cb) return; const id = +cb.dataset.sel; if (cb.checked) { if (state.selected.size >= 2) { const first = [...state.selected][0]; state.selected.delete(first); } state.selected.add(id); } else state.selected.delete(id); renderResults(); });
$('#pt-table').addEventListener('click', (e) => { const d = e.target.closest('[data-del]'); if (!d) return; const id = +d.dataset.del; state.points = state.points.filter((p) => p.id !== id); state.dists = state.dists.filter((x) => x.a !== id && x.b !== id); state.selected.delete(id); renderResults(); });
$('#dist-table').addEventListener('click', (e) => { const d = e.target.closest('[data-ddel]'); if (!d) return; state.dists.splice(+d.dataset.ddel, 1); renderResults(); });
$('#btn-dist-sel').onclick = () => { const [a, b] = [...state.selected].map((id) => state.points.find((p) => p.id === id)); if (a && b) { addDistance(a, b); state.selected.clear(); renderResults(); } };
$('#btn-clear').onclick = () => { if (!state.points.length || confirm('측정한 점과 거리를 모두 지울까요?')) { state.points = []; state.dists = []; state.selected.clear(); renderResults(); } };
// 설정
$('#set-n').onchange = (e) => { state.settings.n = Math.max(2, Math.min(12, +e.target.value || 5)); e.target.value = state.settings.n; updateMeasureUI(); };
$('#set-snap').onchange = (e) => (state.settings.snap = e.target.checked); $('#set-refine').onchange = (e) => (state.settings.refine = e.target.checked); $('#set-loupe').onchange = (e) => (state.settings.loupe = e.target.checked); $('#set-labels').onchange = (e) => (state.settings.labels = e.target.checked);
$('#set-zoom').oninput = (e) => { state.settings.zoom = +e.target.value; $('#zoom-label').textContent = `${e.target.value}×`; }; $('#set-dunit').onchange = (e) => { state.settings.dunit = e.target.value; renderResults(); };
// 드롭
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); if (state.mesh) dz.classList.remove('hidden'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); if (state.mesh) dz.classList.add('hidden'); }));
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });
// 포인터 (클릭 vs 드래그 구분)
let down = null;
document.addEventListener('pointerdown', (e) => { if (e.target !== renderer?.domElement || e.button !== 0) return; down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
document.addEventListener('pointerup', (e) => { if (!down || e.button !== 0) return; const mv = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t; down = null; if (mv < 4 && dt < 600 && state.task && e.target === renderer.domElement) { const r = renderer.domElement.getBoundingClientRect(); onMeasureClick(e.clientX - r.left, e.clientY - r.top); } });
document.addEventListener('pointermove', (e) => { if (!renderer) return; const r = renderer.domElement.getBoundingClientRect(); state.mouse.x = e.clientX - r.left; state.mouse.y = e.clientY - r.top; state.mouse.inside = e.target === renderer.domElement; });
// 키
document.addEventListener('keydown', (e) => { if (e.target.matches('input,select,textarea')) return; if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; } const k = e.key.toLowerCase(); if (k === 'm') $('#btn-point').click(); else if (k === 'd') $('#btn-dist').click(); else if (k === 'r') autoRotate(); else if (k === 'h') frameAll(); else if (k === 'f') { const rp = refPoint(); if (rp) moveTarget(rp); } else if (e.key === 'Enter') finishPoint(); else if (e.key === 'Escape') $('#btn-cancel').click(); else if (e.key === 'Backspace') { e.preventDefault(); undoRay(); } else if (e.key === '?') openHelp(); else if (e.key === '[' || e.key === ']') { state.settings.zoom = Math.max(2, Math.min(8, state.settings.zoom + (e.key === ']' ? 1 : -1))); $('#set-zoom').value = state.settings.zoom; $('#zoom-label').textContent = `${state.settings.zoom}×`; } });
function resetAll(keepFile) { state.points = []; state.dists = []; state.selected.clear(); state.nextId = 1; state.task = null; cancelPoint(false); $$('#btn-point,#btn-dist').forEach((b) => b.classList.remove('active')); $('#measure-idle').hidden = false; $('#measure-live').hidden = true; renderResults(); }
function runTour() { document.getElementById('app').classList.add('tour-active'); startTour(TOUR_STEPS, { onDone: () => { document.getElementById('app').classList.remove('tour-active'); try { localStorage.setItem('gsm.tourSeen', '1'); } catch (_) {} } }); }

// ------------------------------------------------------------------ 시작
if (initGL()) {
  coach('', '3DGS 파일을 열어 시작하세요. 처음이라면 <b>기능 소개 투어</b>를 눌러 보세요.');
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
  startTask, finishPoint, endTask, frameAll, autoRotate, openChecklist, openCalibWizard, applyManualScale(s) { state.unit = { known: true, factor: s, sigmaRel: 0, source: 'test' }; applyUnitUI(); },
  distanceInfo, intersectRays, render() { renderer.render(scene, camera); drawOverlay(); },
  pixel(px, py) { const g = grabGray(px, py, 3); const r = glRatio(); scratch.width = 1; scratch.height = 1; sctx.drawImage(renderer.domElement, px * r, py * r, 1, 1, 0, 0, 1, 1); return Array.from(sctx.getImageData(0, 0, 1, 1).data); },
};
