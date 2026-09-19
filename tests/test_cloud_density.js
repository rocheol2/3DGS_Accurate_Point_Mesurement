// 점군 밀도(가우시안 크기 원판 vs 고정 px)와 색 재현 검사 + 실제 샘플 스크린샷
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (/shader|error/i.test(m.text())) errs.push(m.text().slice(0, 200)); });
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); Object.assign(window.__state.settings, { autoRotate: false, loupeHiRes: false, pickHelpSeen: true }); });
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(500);
  await p.evaluate(() => window.__app.setCamera([5.5, 5.0, 4.0], [1, 1, 1], [0, 0, 1])); await frame();
  const lit = async () => p.evaluate(() => { const g = document.querySelector('#gl canvas'); const c = document.createElement('canvas'); c.width = g.width; c.height = g.height; const x = c.getContext('2d'); x.drawImage(g, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] > 60) n++; if (d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 90) red++; } return { litPct: +(100 * n / (d.length / 4)).toFixed(1), redPx: red }; });
  const splat = await lit();
  await p.evaluate(() => { window.__state.settings.viewMode = 'cloud'; window.__app.applyViewMode(); }); await frame(); await frame();
  const gauss = await lit(); await p.screenshot({ path: 'shots/31_cloud_gauss.png' });
  await p.evaluate(() => { window.__state.settings.ptMode = 'px'; }); await frame(); await frame(); const px = await lit(); await p.screenshot({ path: 'shots/32_cloud_px.png' });
  await p.evaluate(() => { window.__state.settings.ptMode = 'gauss'; window.__state.settings.ptScale = 2; }); await frame(); await frame(); const g2 = await lit(); await p.evaluate(() => { window.__state.settings.ptScale = 0.7; });
  console.log(`화면 채움: 스플랫 ${splat.litPct} % | 점군-가우시안크기 ${gauss.litPct} % (빨강 픽셀 ${gauss.redPx}) | 점군-고정 2px ${px.litPct} % | 배율 2× ${g2.litPct} %`);
  // 모서리 색: 스플랫 대비 점군 색 (빨강 모서리가 빨갛게 나오는지)
  await p.evaluate(() => { window.__state.settings.ptScale = 1; }); await frame(); const edge = await p.evaluate(() => { const s = window.__app.project([1, 2, 2]); return { s, c: window.__app.pixel(s.x, s.y) }; });
  console.log('모서리 중점 픽셀(점군):', edge.c.join(','), '(빨강 기대 ≈ 230,60,30)');
  // 실제 샘플로 스크린샷
  await p.evaluate(() => { window.__state.settings.viewMode = 'cloud'; }); await p.click('#btn-sample'); await p.waitForFunction(() => window.__state.mesh && document.querySelector('#loading').hidden, { timeout: 120000 }); await sleep(1500);
  await p.evaluate(() => { window.__state.settings.viewMode = 'cloud'; window.__app.applyViewMode(); }); await frame(); await frame(); const smp = await lit(); await p.screenshot({ path: 'shots/33_sample_cloud_gauss.png' });
  await p.evaluate(() => { window.__state.settings.viewMode = 'splat'; window.__app.applyViewMode(); }); await frame(); await frame(); const smpS = await lit(); await p.screenshot({ path: 'shots/34_sample_splat.png' });
  console.log(`실제 샘플 화면 채움: 점군(가우시안 크기) ${smp.litPct} % vs 스플랫 ${smpS.litPct} % | errors: ${errs.length ? errs : 'none'}`);
  const ok = gauss.litPct > px.litPct * 1.5 && gauss.redPx > 500 && edge.c[0] > 150 && edge.c[1] < 120 && smp.litPct > 0.6 * smpS.litPct && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
