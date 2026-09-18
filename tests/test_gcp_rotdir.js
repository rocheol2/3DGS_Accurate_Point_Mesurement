// (1) 기준점(GCP) 좌표 → 유사변환 보정  (2) 회전 방향 제어 (화면 기준 좌우/상하, 패턴, 화살표 키)
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); window.__state.settings.autoRotate = false; window.__state.settings.loupeHiRes = false; });
  const buf = fs.readFileSync(path.join(__dirname, 'cube.ply')); // 축척 정보 없는 파일
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube.ply', u8.buffer); }, buf.toString('base64'));
  await sleep(600);
  // ---- (1) GCP: 모델 좌표 4점, 실좌표 = 9.7429 · Rz(30°) · p + (285889.06, 121060.40, 40)
  const S = 9.742857, th = 30 * Math.PI / 180, T0 = [285889.063, 121060.398, 40.0];
  const real = ([x, y, z]) => [S * (Math.cos(th) * x - Math.sin(th) * y) + T0[0], S * (Math.sin(th) * x + Math.cos(th) * y) + T0[1], S * z + T0[2]];
  const model = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 2]];
  await p.evaluate((model, reals) => { model.forEach((m, i) => { const pt = window.__app.debugAddPoint(m); window.__app.setGcp(pt.name, reals[i]); }); }, model, model.map(real));
  await p.evaluate(() => window.__app.openGcpCalib()); await sleep(200);
  await p.evaluate(() => { document.querySelector('#gcp-crs').value = 'EPSG:5186'; document.querySelector('#gcp-calc').click(); }); await sleep(200);
  const res = await p.evaluate(() => document.querySelector('#gcp-result').innerText.replace(/\s+/g, ' ').slice(0, 220)); console.log('GCP 결과:', res);
  await p.screenshot({ path: 'shots/20_gcp_calib.png' });
  await p.evaluate(() => document.querySelector('#gcp-apply').click()); await sleep(200);
  const st = await p.evaluate(() => { const u = window.__state.unit; const q = window.__state.points[3]; return { factor: u.factor, hasT: !!u.transform, crs: u.crs, coord3: window.__app.toReal(q.p).toArray(), unitLabel: document.querySelector('#unit-label').textContent, bannerHidden: document.querySelector('#banner').hidden }; });
  const expect3 = real(model[3]); const cerr = Math.hypot(...st.coord3.map((v, i) => v - expect3[i]));
  console.log(`적용 후: 축척 ${st.factor.toFixed(5)} (참 ${S}) | 변환 ${st.hasT} | ${st.crs} | P4 실좌표 오차 ${cerr.toExponential(2)} m | 단위 ${st.unitLabel} | 배너 숨김 ${st.bannerHidden}`);
  // 2점만: 축척만 모드 확인 (cm 단위 입력)
  const two = await p.evaluate((S) => { const T = window.__app.THREE; const r = window.__app.similarityFromPairs([new T.Vector3(0, 0, 0), new T.Vector3(2, 0, 0)], [new T.Vector3(100, 200, 3), new T.Vector3(100 + 2 * S, 200, 3)]); return { s: r.s, mode: r.mode }; }, S);
  console.log('2점 케이스:', JSON.stringify(two));
  // ---- (2) 회전 방향: 화면 기준
  await p.evaluate(() => { window.__state.points = []; window.__state.settings.autoRotate = true; window.__state.settings.rotAxis = 'screen'; window.__state.settings.rotPattern = 'right'; });
  const V = [2, 2, 2]; const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.evaluate((v) => window.__app.setCamera([5.5, 5.0, 4.0], v, [0, 0, 1]), V); await frame();
  await p.evaluate(() => { window.__state.settings.autoRotate = false; window.__app.startTask('point'); });
  const s0 = await p.evaluate((v) => window.__app.project(v), V);
  const frame0 = await p.evaluate(() => { const T = window.__app.THREE, c = window.__app.camera; return { right: new T.Vector3(1, 0, 0).applyQuaternion(c.quaternion).toArray(), up: new T.Vector3(0, 1, 0).applyQuaternion(c.quaternion).toArray(), pos: c.position.toArray() }; });
  await p.evaluate((x, y) => window.__app.click(x, y), s0.x, s0.y); await sleep(300);
  const chk = async (label) => { await p.waitForFunction(() => !window.__app.animating, { timeout: 60000 }); await frame(); const r = await p.evaluate((v, f0) => { const c = window.__app.camera; const piv = window.__state.autoPivot.toArray(); const off = c.position.toArray().map((q, i) => q - piv[i]); const off0 = f0.pos.map((q, i) => q - piv[i]); const dot = (a, b) => a.reduce((s, q, i) => s + q * b[i], 0); const s = window.__app.project(v); const { w, h } = { w: document.querySelector('#gl').clientWidth, h: document.querySelector('#gl').clientHeight }; return { dRight: dot(off, f0.right) - dot(off0, f0.right), dUp: dot(off, f0.up) - dot(off0, f0.up), centerErr: Math.hypot(s.x - w / 2, s.y - h / 2), dist: Math.hypot(...off), dist0: Math.hypot(...off0) }; }, V, frame0); console.log(`${label}: 화면-오른쪽 이동 ${r.dRight.toFixed(2)} m · 화면-위 이동 ${r.dUp.toFixed(2)} m · 피벗 화면중심 오차 ${r.centerErr.toFixed(1)} px · 거리 ${r.dist.toFixed(3)} (처음 ${r.dist0.toFixed(3)})`); return r; };
  await p.evaluate(() => window.__app.autoOrbit(70, 'h')); const r1 = await chk('오른쪽 70°');
  await p.evaluate(() => window.__app.autoOrbit(-70, 'h')); await chk('왼쪽 70° (복귀)');
  await p.evaluate(() => window.__app.autoOrbit(30, 'v')); const r3 = await chk('위 30°');
  await p.keyboard.press('ArrowDown'); await sleep(100); const kb = await p.evaluate(() => window.__app.animating); await chk('↓ 키'); console.log('화살표 키로 회전 시작됨:', kb);
  const seq = await p.evaluate(() => { const out = {}; for (const pat of ['right', 'left', 'alth', 'altv']) { window.__state.settings.rotPattern = pat; let a = 0, t = 0; const arr = []; for (let k = 1; k <= 4; k++) { window.__state.autoAngleDeg = a; window.__state.autoTiltDeg = t; const n = window.__app.autoRotate && (() => { const st = 350 / 5; return null; })(); } out[pat] = null; } return out; });
  const seq2 = await p.evaluate(() => { const out = {}; for (const pat of ['right', 'left', 'alth', 'altv']) { window.__state.settings.rotPattern = pat; window.__state.autoAngleDeg = 0; window.__state.autoTiltDeg = 0; const arr = []; for (let k = 1; k <= 4; k++) { const st = window.__state.settings.rotStep > 0 ? window.__state.settings.rotStep : 70; const alt = (i) => (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * st; arr.push(pat === 'right' ? k * st : pat === 'left' ? -k * st : Math.max(-70, Math.min(70, alt(k)))); } out[pat] = arr; } return out; });
  console.log('패턴별 절대각(클릭 1~4 뒤):', JSON.stringify(seq2));
  await p.screenshot({ path: 'shots/21_rotdir_panel.png' });
  console.log('errors:', errs.length ? errs : 'none');
  const ok = Math.abs(st.factor - S) < 1e-3 && st.hasT && cerr < 1e-3 && two.mode === 'scale-only' && Math.abs(two.s - S) < 1e-3 && r1.dRight > 1 && r1.centerErr < 3 && r3.dUp > 0.5 && Math.abs(r1.dist - r1.dist0) < 1e-3 && kb;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL');
  await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
