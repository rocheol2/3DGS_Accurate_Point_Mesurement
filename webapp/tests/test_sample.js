// 실제 3DGS 샘플(진주 LH 현장 15만 가우시안) 로드·렌더 확인 + 스크린샷
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, 'shots'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900', '--use-gl=angle'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  const logs = []; page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`)); page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto('http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app);
  const t0 = Date.now(); await page.click('#drop-sample');
  await page.waitForFunction(() => window.__state.mesh && document.querySelector('#loading').hidden, { timeout: 120000 });
  console.log('sample loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await sleep(2500);
  const st = await page.evaluate(() => ({ unit: window.__state.unit, up: document.querySelector('#up-label').textContent, upSource: window.__state.upSource, count: window.__state.file.count, bounds: { c: window.__state.bounds.center.toArray().map((v) => +v.toFixed(2)), r: +window.__state.bounds.radius.toFixed(2) } }));
  console.log('state:', JSON.stringify(st));
  await page.screenshot({ path: path.join(OUT, '07_sample_site01.png') });
  // 화면 중앙 근처 픽셀이 배경색이 아닌지(모델이 그려졌는지) 확인
  const px = await page.evaluate(() => { const out = []; for (const [x, y] of [[500, 400], [600, 450], [700, 350]]) out.push(window.__app.pixel(x, y)); return out; });
  console.log('center pixels:', JSON.stringify(px));
  // 측정 모드 진입 + 첫 클릭 → 안내 UI 스크린샷 (루페는 마우스 이동 시)
  await page.evaluate(() => window.__app.startTask('point'));
  await page.mouse.move(620, 430); await sleep(200); await page.mouse.down(); await page.mouse.up(); await sleep(600);
  await page.mouse.move(640, 440); await sleep(300);
  await page.screenshot({ path: path.join(OUT, '08_sample_measure_loupe.png') });
  await page.evaluate(() => window.__app.autoRotate()); await sleep(900);
  await page.mouse.move(700, 420); await sleep(300);
  await page.screenshot({ path: path.join(OUT, '09_sample_after_autorotate.png') });
  console.log('--- errors ---'); logs.filter((l) => /error|pageerror/i.test(l)).slice(0, 10).forEach((l) => console.log(l));
  await browser.close();
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
