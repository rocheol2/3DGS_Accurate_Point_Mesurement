// 지역·국가 좌표계(큰 좌표) PLY: 뷰어 자동 원점 이동 → 렌더 정상, 표시 좌표는 원래 값, 거리 정확, GCP 보정도 원래 좌표 기준
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); window.__state.settings.autoRotate = false; window.__state.settings.loupeHiRes = false; });
  const file = process.env.BIG_PLY || path.join(__dirname, 'cube_big.ply'); const buf = fs.readFileSync(file);
  const t0 = Date.now();
  await p.evaluate(async (b64, name) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer(name, u8.buffer); }, buf.toString('base64'), path.basename(file));
  await sleep(800);
  const st = await p.evaluate(() => ({ off: window.__state.coordOffset, bounds: { c: window.__state.bounds.center.toArray().map((v) => +v.toFixed(2)), r: +window.__state.bounds.radius.toFixed(2) }, toasts: Array.from(document.querySelectorAll('.toast b')).map((t) => t.textContent.slice(0, 40)), count: window.__state.file.count }));
  console.log(`로드 ${((Date.now() - t0) / 1000).toFixed(1)} s | 오프셋 ${JSON.stringify(st.off)} | 뷰어 내부 경계 중심 ${JSON.stringify(st.bounds)} | 가우시안 ${st.count}`); console.log('토스트:', JSON.stringify(st.toasts));
  if (process.env.BIG_PLY) { // 실제 파일: 렌더만 확인
    await p.evaluate(() => window.__app.frameAll()); await sleep(1500); await p.screenshot({ path: 'shots/24_bigcoord_real.png' });
    const px = await p.evaluate(() => { let lit = 0; for (const [x, y] of [[400, 350], [530, 400], [650, 450], [500, 500]]) { const c = window.__app.pixel(x, y); if (c[0] + c[1] + c[2] > 60) lit++; } return lit; });
    console.log('화면 표본 4점 중 모델 픽셀:', px, '| errors:', errs.length ? errs : 'none'); console.log('RESULT:', st.off && px >= 2 && !errs.length ? 'PASS' : 'FAIL'); await b.close(); process.exit(0);
  }
  // 합성 정육면체: 원래 꼭짓점 (285891.063, 121062.398, 42) → 뷰어 내부 = 원래 − 오프셋
  const OFF = st.off; const Vorig = [285891.063, 121062.398, 42.0], Vin = Vorig.map((v, i) => v - OFF[i]); const V2orig = [285889.063, 121062.398, 42.0], V2in = V2orig.map((v, i) => v - OFF[i]);
  const poses = [[3.5, 3.0, 2.0], [2.0, 4.5, 1.5], [4.5, 1.5, 1.0], [3.0, 2.5, 4.0], [1.5, 3.5, 3.0]].map((q) => q.map((v, i) => v + Vin[i]));
  const measure = async (v) => { await p.evaluate(() => window.__app.startTask('point')); for (const pose of poses) { await p.evaluate((pos, tgt) => window.__app.setCamera(pos, tgt, [0, 0, 1]), pose, v); await sleep(300); const s = await p.evaluate(async (v) => { window.__app.render(); await new Promise((r) => requestAnimationFrame(r)); window.__app.render(); const s = window.__app.project(v); return { s, px: window.__app.pixel(s.x, s.y) }; }, v); if (pose === poses[0]) console.log('  꼭짓점 픽셀 색:', s.px.join(','), '(노랑 기대)'); await p.evaluate((x, y) => window.__app.click(x, y), s.s.x, s.s.y); await sleep(300); } await sleep(200); return p.evaluate(() => { const q = window.__state.points[window.__state.points.length - 1]; return { disp: document.querySelector('#pt-table tbody tr:last-child td:nth-child(3)').textContent, orig: window.__app.origCoord(q.p).toArray(), sigma0: q.sigma0 }; }); };
  const A = await measure(Vin); const errA = Math.hypot(...A.orig.map((v, i) => v - Vorig[i])); console.log(`P1 표시: ${A.disp} | 원래 좌표 복원 오차 ${errA.toFixed(4)} m`);
  const B = await measure(V2in); const errB = Math.hypot(...B.orig.map((v, i) => v - V2orig[i]));
  const d = await p.evaluate(() => { const [a, b] = window.__state.points; return window.__app.distanceInfo(a, b).d; }); console.log(`P2 복원 오차 ${errB.toFixed(4)} m | 거리 ${d.toFixed(4)} (참 2.000)`);
  await p.evaluate(() => window.__app.endTask()); await p.evaluate(() => window.__app.openChecklist()); await sleep(200); await p.screenshot({ path: 'shots/23_bigcoord_checklist.png' }); await p.evaluate(() => document.querySelector('#modal-close').click());
  // GCP: 원래 좌표 자체가 실좌표라고 입력 → 축척 1, 변환 항등, 잔차 ~0 이어야 함
  await p.evaluate((V, V2) => { const [a, b2] = window.__state.points; window.__app.setGcp(a.name, V); window.__app.setGcp(b2.name, V2); }, Vorig, V2orig);
  await p.evaluate(() => window.__app.openGcpCalib()); await sleep(200); await p.evaluate(() => document.querySelector('#gcp-calc').click()); await sleep(200);
  const g = await p.evaluate(() => document.querySelector('#gcp-result').innerText.replace(/\s+/g, ' ').slice(0, 120)); console.log('GCP(2점, 원래 좌표 그대로):', g);
  console.log('errors:', errs.length ? errs : 'none');
  const ok = st.off && st.toasts.some((t) => t.includes('원점')) && errA < 0.06 && errB < 0.06 && Math.abs(d - 2) < 0.05 && /1 u = (0\.99|1\.0)/.test(g) && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
