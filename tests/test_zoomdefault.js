const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
  const url = 'file:///home/rocheol2/storage/Cesium/webapp/dist/3DGS_거리측정기_단일파일_조작메뉴.html#notour';
  await p.goto(url, { waitUntil: 'load' }); await p.waitForFunction(() => window.__app);
  // 옛 설정(4배) 저장돼 있던 상황 재현 → 새로고침 후 2배로 이전되는지
  await p.evaluate(() => localStorage.setItem('gsm.settings', JSON.stringify({ zoom: 4, loupeSize: 'm' })));
  await p.reload({ waitUntil: 'load' }); await p.waitForFunction(() => window.__app);
  const z = await p.evaluate(() => ({ zoom: window.__state.settings.zoom, label: document.querySelector('#zoom-label').textContent, size: window.__state.settings.loupeSize, min: document.querySelector('#set-zoom').min }));
  console.log('설정:', JSON.stringify(z));
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(500);
  await p.evaluate(() => window.__app.startTask('point')); const s = await p.evaluate(() => window.__app.project([2, 2, 2])); const r = await p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top }; });
  await p.mouse.move(r.l + s.x, r.t + s.y); await sleep(400);
  const info = await p.evaluate(() => ({ info: document.querySelector('#loupe-info').textContent, w: document.querySelector('#loupe').style.width })); console.log('확대창:', JSON.stringify(info));
  await p.screenshot({ path: 'shots/25_loupe_2x.png' });
  console.log('RESULT:', z.zoom === 2 && info.w === '260px' && info.info.startsWith('2×') ? 'PASS' : 'FAIL'); await b.close();
})();
