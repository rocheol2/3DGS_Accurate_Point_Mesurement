// 조밀 표본 점군: 점 수 ×K, 생성 시간, 화면 채움, 1 px 크기, 실제 샘플(15만 → 150만) 성능
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (/error/i.test(m.text())) errs.push(m.text().slice(0, 160)); });
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); Object.assign(window.__state.settings, { autoRotate: false, loupeHiRes: false, pickHelpSeen: true }); });
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(500);
  const info = await p.evaluate(() => ({ mode: window.__state.settings.ptMode, dense: window.__state.denseInfo, n: window.__state.cloud.n, label: document.querySelector('#q-dense-info').textContent, ptSize: window.__state.settings.ptSize }));
  console.log('정육면체:', JSON.stringify(info));
  await p.keyboard.press('Tab'); await p.evaluate(() => window.__app.setCamera([5.5, 5.0, 4.0], [1, 1, 1], [0, 0, 1])); await frame(); await frame();
  const lit = async () => p.evaluate(() => { const g = document.querySelector('#gl canvas'); window.__app.render(); const c = document.createElement('canvas'); c.width = g.width; c.height = g.height; const x = c.getContext('2d'); x.drawImage(g, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return +(100 * n / (d.length / 4)).toFixed(1); });
  const litDense = await lit(); await p.screenshot({ path: 'shots/36_dense_cube.png' });
  // 근접 시 점이 작은지: 꼭짓점 0.3 m 앞 → 마커 주변 노란 영역 폭
  await p.evaluate(() => window.__app.setCamera([2.2, 2.2, 2.15], [2, 2, 2], [0, 0, 1])); await frame(); await frame();
  const w = await p.evaluate(() => { window.__app.render(); const s = window.__app.project([2, 2, 2]); let l = s.x, r = s.x; const isY = (x) => { const c = window.__app.pixel(x, s.y); return c[0] > 180 && c[1] > 180 && c[2] < 120; }; while (l > 0 && isY(l - 1)) l--; while (r < 1000 && isY(r + 1)) r++; return r - l + 1; });
  await p.screenshot({ path: 'shots/37_dense_close.png' });
  // 직접 선택은 중심점 기준으로 여전히 정확한지
  await p.evaluate(() => window.__app.setCamera([5.5, 5.0, 4.0], [2, 2, 2], [0, 0, 1])); await frame(); await p.evaluate(() => window.__app.startTask('point'));
  const s = await p.evaluate(() => window.__app.project([2, 2, 2])); const r = await p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top }; }); await p.mouse.click(r.l + s.x, r.t + s.y); await sleep(300);
  const pk = await p.evaluate(() => { const q = window.__state.points[0]; return q && Math.hypot(q.p.x - 2, q.p.y - 2, q.p.z - 2); }); await p.evaluate(() => window.__app.endTask());
  console.log(`점군 화면 채움 ${litDense} % | 근접 시 마커 폭 ${w} px | 직접 선택 오차 ${(pk * 1000).toFixed(1)} mm`);
  // 실제 샘플: 15만 가우시안 → 자동 ×10 = 150만 점, 생성 시간·프레임 시간
  await p.click('#btn-sample'); await p.waitForFunction(() => window.__state.mesh && document.querySelector('#loading').hidden, { timeout: 120000 }); await sleep(1000);
  const smp = await p.evaluate(() => ({ dense: window.__state.denseInfo, n: window.__state.cloud.n }));
  await p.evaluate(() => { window.__state.settings.viewMode = 'cloud'; window.__app.applyViewMode(); }); await frame(); await frame();
  const ft = await p.evaluate(async () => { const t0 = performance.now(); for (let i = 0; i < 5; i++) { window.__app.render(); await new Promise((r) => requestAnimationFrame(r)); } return +((performance.now() - t0) / 5).toFixed(0); });
  const litS = await lit(); await p.screenshot({ path: 'shots/38_dense_sample.png' });
  console.log(`실제 샘플: 가우시안 ${smp.n.toLocaleString()} → 표시 ${smp.dense.total.toLocaleString()}점 (×${smp.dense.K}, 생성 ${smp.dense.ms} ms, 약 ${smp.dense.mb} MB) | 프레임 ${ft} ms (소프트웨어 렌더러) | 채움 ${litS} %`);
  // 밀도 배수 변경(×3) → 재생성
  await p.evaluate(() => { document.querySelector('#q-densify').value = '3'; document.querySelector('#q-densify').dispatchEvent(new Event('change')); }); await sleep(300); const k3 = await p.evaluate(() => window.__state.denseInfo.K + '/' + window.__state.denseInfo.total);
  console.log('밀도 ×3 선택 →', k3, '| errors:', errs.length ? errs : 'none');
  const ok = info.mode === 'dense' && info.dense.K === 10 && info.dense.total === info.n * 10 && info.ptSize === 1 && w <= 12 && pk < 0.01 && smp.dense.K === 10 && smp.dense.total >= smp.n * 10 * 0.98 && smp.dense.ms < 5000 && k3.startsWith('3/') && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
