// 자동 회전(350°/N) + 확대창 크기/고해상도 테스트: 사용자는 회전이 끝난 뒤 같은 꼭짓점을 다시 클릭하기만 함
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (/확대창 고해상도 렌더 실패|error/i.test(m.text())) errs.push(m.text().slice(0, 150)); });
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.removeItem('gsm.settings'); window.__state.settings.autoRotate = true; window.__state.settings.loupeHiRes = true; window.__state.settings.n = 5; });
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64'));
  await sleep(600);
  const V = [2, 2, 2];
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.evaluate((v) => window.__app.setCamera([5.5, 5.0, 4.0], v, [0, 0, 1]), V); await frame();
  await p.evaluate(() => window.__app.startTask('point'));
  const r = await p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { left: q.left, top: q.top, w: q.width, h: q.height }; });
  const az = (pos, piv) => Math.atan2(pos[1] - piv[1], pos[0] - piv[0]) * 180 / Math.PI;
  let prevAz = null;
  for (let i = 1; i <= 5; i++) {
    const s = await p.evaluate((v) => window.__app.project(v), V);
    // 확대창: 마우스를 꼭짓점 위로 → 루페 표시 확인 (1번째 클릭 전)
    await p.mouse.move(r.left + s.x, r.top + s.y); await frame(); await frame();
    if (i === 1) { const lp = await p.evaluate(() => { const c = document.querySelector('#loupe-canvas'); const ctx = c.getContext('2d'); const d = ctx.getImageData(0, 0, c.width, c.height).data; let bright = 0; for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] > 150) bright++; return { hidden: document.querySelector('#loupe').hidden, size: document.querySelector('#loupe').style.width, canvas: c.width, brightPx: bright, info: document.querySelector('#loupe-info').textContent }; }); console.log('loupe (중, 고해상도):', JSON.stringify(lp)); await p.screenshot({ path: 'shots/17_loupe_hires_m.png' });
      await p.evaluate(() => document.querySelector('#live-loupe-size [data-ls="l"]').click()); await frame(); await frame(); const lp2 = await p.evaluate(() => ({ size: document.querySelector('#loupe').style.width, canvas: document.querySelector('#loupe-canvas').width, on: document.querySelector('#set-loupe-size .on')?.dataset.ls })); console.log('loupe (대):', JSON.stringify(lp2)); await p.screenshot({ path: 'shots/18_loupe_hires_l.png' }); }
    // 클릭 (사용자처럼 실제 마우스 클릭)
    await p.mouse.down(); await p.mouse.up();
    // 자동 회전 애니메이션 종료 대기
    try { const tw0 = Date.now(); await p.waitForFunction(() => !window.__app.animating, { timeout: 90000 }); console.log('   (회전 애니메이션 완료까지 ' + ((Date.now() - tw0) / 1000).toFixed(1) + ' s — 소프트웨어 렌더러 프레임 시간 포함)'); } catch (e) { const dbg = await p.evaluate(() => ({ rays: window.__state.rays.length, est: window.__state.estimate ? window.__state.estimate.p.toArray() : null, pivot: window.__state.autoPivot?.toArray(), cam: window.__app.camera.position.toArray(), target: window.__app.controls.target.toArray(), pts: window.__state.points.length, task: !!window.__state.task })); console.log('TIMEOUT dbg:', JSON.stringify(dbg), 'errs:', JSON.stringify(errs)); throw e; } await frame(); await frame();
    const st = await p.evaluate((v) => { const c = window.__app.camera; const s = window.__app.project(v); return { rays: window.__state.rays.length, pos: c.position.toArray(), piv: window.__state.autoPivot?.toArray(), vpx: [Math.round(s.x), Math.round(s.y)], acc: window.__state.autoAngleDeg, pts: window.__state.points.length }; }, V);
    const a = st.piv ? az(st.pos, st.piv) : null; const dAz = prevAz == null ? null : ((a - prevAz + 540) % 360) - 180; prevAz = a;
    console.log(`click ${i}: rays=${st.rays} | 회전 후 꼭짓점 px=${st.vpx} (화면 중심 ${Math.round(r.w / 2)},${Math.round(r.h / 2)}) | 방위각 변화 ${dAz == null ? '-' : dAz.toFixed(1) + '°'} | 누적 ${st.acc}° | 확정 점 ${st.pts}`);
    if (i === 2) await p.screenshot({ path: 'shots/19_autorotate_view.png' });
  }
  const pt = await p.evaluate(() => { const q = window.__state.points[0]; return q ? { p: q.p.toArray(), sigma0: q.sigma0, ang: q.maxAngleDeg, q: q.quality } : null; });
  const err = pt ? Math.hypot(pt.p[0] - 2, pt.p[1] - 2, pt.p[2] - 2) : NaN;
  console.log('확정 점:', JSON.stringify(pt), '→ 3D 오차', err.toFixed(4), 'm');
  console.log('errors:', errs.length ? errs : 'none');
  console.log('RESULT:', pt && err < 0.02 && pt.ang > 60 ? 'PASS' : 'FAIL');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
