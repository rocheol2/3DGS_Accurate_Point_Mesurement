const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); Object.assign(window.__state.settings, { autoRotate: false, loupeHiRes: false, pickHelpSeen: true }); });
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(500);
  await p.keyboard.press('Tab'); await frame();
  const q = await p.evaluate(() => ({ quickVisible: !document.querySelector('#cloud-quick').hidden, max: window.__state.settings.ptMaxPx, label: document.querySelector('#q-ptmax-label').textContent }));
  // 가까이(꼭짓점 0.3 m 앞)에서 원판 지름 측정: 꼭짓점 마커 주변 노란 픽셀 폭
  await p.evaluate(() => window.__app.setCamera([2.2, 2.2, 2.15], [2, 2, 2], [0, 0, 1])); await frame(); await frame();
  const width = async () => p.evaluate(() => { const s = window.__app.project([2, 2, 2]); let l = s.x, r = s.x; const isY = (x) => { const c = window.__app.pixel(x, s.y); return c[0] > 180 && c[1] > 180 && c[2] < 120; }; while (l > 0 && isY(l - 1)) l--; while (r < 1000 && isY(r + 1)) r++; return r - l + 1; });
  const w6 = await width();
  await p.keyboard.press('-'); await p.keyboard.press('-'); await frame(); await frame(); const w4 = await width(); const s4 = await p.evaluate(() => window.__state.settings.ptMaxPx);
  await p.evaluate(() => { document.querySelector('#q-ptmax').value = 20; document.querySelector('#q-ptmax').dispatchEvent(new Event('input')); }); await frame(); await frame(); const w20 = await width();
  console.log(`빠른 조절 표시 ${q.quickVisible}, 기본 최대 ${q.max} px (${q.label}) | 근접 시 꼭짓점 원판 폭: 기본 ${w6} px → '-' 2회(${s4} px) ${w4} px → 슬라이더 20 px ${w20} px`);
  await p.screenshot({ path: 'shots/35_ptsize_quick.png' });
  const ok = q.quickVisible && q.max === 6 && w4 < w6 && w20 > w6 && s4 === 4 && !errs.length; console.log('errors:', errs.length ? errs : 'none'); console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
