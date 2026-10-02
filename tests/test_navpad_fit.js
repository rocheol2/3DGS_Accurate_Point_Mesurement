// 조작 패널: 모든 버튼·제목이 패널 경계 안에 있는지 (창 폭 3종)
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage(); let ok = true;
  for (const [w, h] of [[1400, 900], [1000, 700], [760, 600]]) {
    await p.setViewport({ width: w, height: h });
    await p.goto(process.env.APP_URL, { waitUntil: 'load' }); await p.waitForFunction(() => window.__app);
    await p.evaluate(() => { localStorage.clear(); });
    const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
    await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(400);
    const r = await p.evaluate(() => { const pad = document.querySelector('#navpad'); const P = pad.getBoundingClientRect(); const host = document.querySelector('#gl').getBoundingClientRect(); let worst = 0; const out = []; for (const el of pad.querySelectorAll('[data-nav], .nav-title, .nav-foot, .nav-head')) { const q = el.getBoundingClientRect(); const over = Math.max(P.left - q.left, q.right - P.right, P.top - q.top, q.bottom - P.bottom); if (over > worst) worst = over; if (over > 0.5) out.push((el.dataset.nav || el.className) + ':' + over.toFixed(1)); } return { padW: Math.round(P.width), padH: Math.round(P.height), worst: +worst.toFixed(1), out, insideHost: P.left >= host.left && P.right <= host.right + 0.5 }; });
    console.log(`창 ${w}×${h}: 패널 ${r.padW}×${r.padH} px | 경계 밖으로 나간 최대 ${r.worst} px ${r.out.length ? JSON.stringify(r.out) : '(없음)'} | 3D 화면 안 ${r.insideHost}`);
    if (r.worst > 0.5 || !r.insideHost) ok = false;
    if (w === 1400) { const c = await p.evaluate(() => { const q = document.querySelector('#navpad').getBoundingClientRect(); return { x: q.left - 10, y: q.top - 10, width: q.width + 20, height: q.height + 20 }; }); await p.screenshot({ path: 'shots/39_navpad_fit.png', clip: c }); }
  }
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
