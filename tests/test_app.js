// 헤드리스 크롬 E2E: 합성 정육면체(모서리 2.000 m)로 측정 정확도·렌더 정합·오류 메시지 검증
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const BASE = process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour';
const OUT = path.join(__dirname, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900', '--enable-webgl', '--use-gl=angle'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const logs = []; page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`)); page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app && window.__state, { timeout: 20000 });
  const webgl2 = await page.evaluate(() => window.__state.webgl2); console.log('WebGL2:', webgl2);
  await page.screenshot({ path: path.join(OUT, '01_landing.png') });
  // --- 파일 로드 (cube_m.ply : 미터 헤더 있음)
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await page.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64'));
  await sleep(1500);
  const st = await page.evaluate(() => ({ unit: window.__state.unit, up: document.querySelector('#up-label').textContent, bounds: { c: window.__state.bounds.center.toArray(), r: window.__state.bounds.radius }, count: window.__state.file.count }));
  console.log('loaded:', JSON.stringify(st));
  // --- 카메라 5개 시점에서 꼭짓점 V=(2,2,2) 를 정확히 클릭 (렌더 정합 확인: 그 픽셀이 노란색인가)
  const V = [2, 2, 2]; const V2 = [0, 2, 2];
  const poses = [[5.5, 5.0, 4.0], [4.0, 6.5, 3.5], [6.5, 3.5, 3.0], [5.0, 4.5, 6.0], [3.5, 5.5, 5.0]];
  async function measureVertex(v, label) {
    await page.evaluate(() => window.__app.startTask('point'));
    for (let i = 0; i < poses.length; i++) {
      await page.evaluate((pos, tgt) => window.__app.setCamera(pos, tgt, [0, 0, 1]), poses[i], v);
      await sleep(400); // 정렬/렌더 안정
      const info = await page.evaluate(async (v) => { window.__app.render(); await new Promise((r) => requestAnimationFrame(r)); window.__app.render(); const s = window.__app.project(v); const px = window.__app.pixel(s.x, s.y); return { s, px }; }, v);
      if (i === 0) console.log(`${label} view0 projected:`, info.s.x.toFixed(1), info.s.y.toFixed(1), 'pixel RGBA:', info.px.join(','));
      await page.evaluate((x, y) => window.__app.click(x, y), info.s.x + (Math.random() - 0.5) * 1.0, info.s.y + (Math.random() - 0.5) * 1.0);
      await sleep(450);
      if (i === 1) await page.screenshot({ path: path.join(OUT, `02_${label}_guideline.png`) });
    }
    await sleep(300);
    const pt = await page.evaluate(() => { const p = window.__state.points[window.__state.points.length - 1]; return p ? { name: p.name, p: p.p.toArray(), sigma0: p.sigma0, pxRms: p.pxRms, ang: p.maxAngleDeg, q: p.quality, n: p.n, notes: p.rays.map((r) => r.note) } : null; });
    const err = pt ? Math.hypot(pt.p[0] - v[0], pt.p[1] - v[1], pt.p[2] - v[2]) : NaN;
    console.log(`${label}:`, JSON.stringify(pt), '\n   → 3D error vs truth (m):', err.toFixed(4));
    return { pt, err };
  }
  const A = await measureVertex(V, 'PA'); const B = await measureVertex(V2, 'PB');
  await page.evaluate(() => window.__app.endTask());
  const dist = await page.evaluate(() => { const [a, b] = window.__state.points; return window.__app.distanceInfo(a, b); });
  console.log('distance PA-PB (truth 2.000):', dist.d.toFixed(4), '±', dist.sigma.toFixed(4));
  await page.evaluate(() => { const [a, b] = window.__state.points; document.querySelector('[data-sel="' + a.id + '"]').click(); document.querySelector('[data-sel="' + b.id + '"]').click(); document.querySelector('#btn-dist-sel').click(); });
  await page.evaluate(() => window.__app.setCamera([6, 6, 5], [1, 2, 2], [0, 0, 1])); await sleep(600);
  await page.evaluate(() => document.querySelector('.tab[data-tab="results"]').click());
  await page.screenshot({ path: path.join(OUT, '03_distance.png') });
  // --- 정보 점검 모달
  await page.evaluate(() => window.__app.openChecklist()); await sleep(200); await page.screenshot({ path: path.join(OUT, '04_checklist.png') });
  await page.evaluate(() => document.querySelector('#modal-close').click());
  // --- 축척 없는 파일 (cube.ply): 배너·E05 토스트·모델 단위 표시 확인
  const buf2 = fs.readFileSync(path.join(__dirname, 'cube.ply'));
  await page.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube.ply', u8.buffer); }, buf2.toString('base64'));
  await sleep(1200);
  const noScale = await page.evaluate(() => ({ bannerHidden: document.querySelector('#banner').hidden, bannerText: document.querySelector('#banner-text').innerText.slice(0, 80), unit: window.__state.unit, toasts: Array.from(document.querySelectorAll('.toast b')).map((b) => b.textContent) }));
  console.log('no-scale file:', JSON.stringify(noScale));
  await page.screenshot({ path: path.join(OUT, '05_noscale_banner.png') });
  // 각도 부족(E08) 시나리오: 같은 시점에서 2번 클릭 후 확정 시도
  await page.evaluate(() => window.__app.startTask('point'));
  await page.evaluate(() => window.__app.setCamera([5.5, 5.0, 4.0], [2, 2, 2], [0, 0, 1])); await sleep(300);
  const s0 = await page.evaluate(() => window.__app.project([2, 2, 2]));
  await page.evaluate((x, y) => window.__app.click(x, y), s0.x, s0.y); await sleep(300);
  await page.evaluate(() => window.__app.setCamera([5.6, 5.0, 4.0], [2, 2, 2], [0, 0, 1])); await sleep(300);
  const s1 = await page.evaluate(() => window.__app.project([2, 2, 2]));
  await page.evaluate((x, y) => window.__app.click(x, y), s1.x, s1.y); await sleep(300);
  await page.evaluate(() => window.__app.finishPoint());
  await sleep(200);
  const e08 = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => t.querySelector('b')?.textContent).filter(Boolean));
  console.log('E08 scenario toasts:', JSON.stringify(e08));
  await page.screenshot({ path: path.join(OUT, '06_E08.png') });
  // 수동 축척 적용 → 미터 표시
  await page.evaluate(() => { window.__app.endTask(); window.__app.applyManualScale(1.0); });
  const unitAfter = await page.evaluate(() => document.querySelector('#unit-label').textContent); console.log('unit after manual scale:', unitAfter);
  console.log('\n--- console/page errors (filtered) ---'); logs.filter((l) => /error|warn|pageerror/i.test(l) && !/favicon|THREE.WebGLRenderer: Context Lost/i.test(l)).slice(0, 15).forEach((l) => console.log(l));
  const ok = A.err < 0.02 && B.err < 0.02 && Math.abs(dist.d - 2.0) < 0.02 && noScale.bannerHidden === false;
  console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
  await browser.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
