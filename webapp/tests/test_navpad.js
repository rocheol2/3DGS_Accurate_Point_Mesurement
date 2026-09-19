// 플로팅 조작 패널: 버튼 클릭으로 회전·확대·이동·홈, 누르고 있기(연속), 접기, 드래그 이동
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); window.__state.settings.autoRotate = false; window.__state.settings.loupeHiRes = false; });
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64'));
  await sleep(600);
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const cam = () => p.evaluate(() => { const c = window.__app.camera, t = window.__app.controls.target; return { pos: c.position.toArray().map((v) => +v.toFixed(3)), tgt: t.toArray().map((v) => +v.toFixed(3)), dist: +c.position.distanceTo(t).toFixed(3) }; });
  const vis = await p.evaluate(() => ({ hidden: document.querySelector('#navpad').hidden, btns: document.querySelectorAll('#navpad [data-nav]').length }));
  console.log('패널 표시:', JSON.stringify(vis));
  const c0 = await cam();
  const click = async (act) => { const r = await p.evaluate((a) => { const q = document.querySelector(`#navpad [data-nav="${a}"]`).getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; }, act); await p.mouse.click(r.x, r.y); await frame(); return cam(); };
  const c1 = await click('rr'); const ang = (a, b) => { const va = a.pos.map((v, i) => v - a.tgt[i]), vb = b.pos.map((v, i) => v - b.tgt[i]); const d = va.reduce((s, v, i) => s + v * vb[i], 0) / (Math.hypot(...va) * Math.hypot(...vb)); return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI; };
  console.log(`▶ 회전: 각도 변화 ${ang(c0, c1).toFixed(1)}° (기대 15) · 거리 ${c0.dist}→${c1.dist} · 중심 유지 ${JSON.stringify(c0.tgt) === JSON.stringify(c1.tgt)}`);
  const c2 = await click('ru'); console.log(`▲ 회전: 각도 변화 ${ang(c1, c2).toFixed(1)}°`);
  const c3 = await click('zi'); console.log(`＋ 확대: 거리 ${c2.dist} → ${c3.dist} (감소 기대)`);
  const c4 = await click('zo'); console.log(`－ 축소: 거리 ${c3.dist} → ${c4.dist} (증가 기대)`);
  const c5 = await click('pr'); const dt = Math.hypot(...c5.tgt.map((v, i) => v - c4.tgt[i])); console.log(`→ 이동: 중심 이동량 ${dt.toFixed(3)} (거리의 12 % = ${(c4.dist * 0.12).toFixed(3)})`);
  // 누르고 있기: 0.6초 → 연속 미세 회전
  const r = await p.evaluate(() => { const q = document.querySelector('#navpad [data-nav="rl"]').getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; });
  const c6a = await cam(); await p.mouse.move(r.x, r.y); await p.mouse.down(); await sleep(900); await p.mouse.up(); await frame(); const c6 = await cam();
  console.log(`◀ 누르고 있기 0.9 s: 총 회전 ${ang(c6a, c6).toFixed(1)}° (15° + 연속 2°씩, 15 초과 기대)`);
  const c7 = await click('home'); console.log(`⌂ 홈: 거리 ${c7.dist} (전체 보기)`);
  await p.screenshot({ path: 'shots/22_navpad.png' });
  // 접기 / 드래그 이동 / 숨기기 토글
  await p.evaluate(() => document.querySelector('#nav-fold').click()); const folded = await p.evaluate(() => document.querySelector('#navpad').classList.contains('folded') && getComputedStyle(document.querySelector('#navpad .nav-body')).display === 'none'); await p.evaluate(() => document.querySelector('#nav-fold').click());
  const h = await p.evaluate(() => { const q = document.querySelector('#navpad .nav-head').getBoundingClientRect(); return { x: q.left + 30, y: q.top + q.height / 2 }; });
  const before = await p.evaluate(() => document.querySelector('#navpad').getBoundingClientRect().left);
  await p.mouse.move(h.x, h.y); await p.mouse.down(); await p.mouse.move(h.x + 200, h.y - 150, { steps: 8 }); await p.mouse.up();
  const after = await p.evaluate(() => document.querySelector('#navpad').getBoundingClientRect().left);
  await p.evaluate(() => document.querySelector('#btn-navpad').click()); const hiddenAfter = await p.evaluate(() => document.querySelector('#navpad').hidden); await p.evaluate(() => document.querySelector('#btn-navpad').click());
  console.log(`접기 ${folded} · 드래그 이동 ${before.toFixed(0)}→${after.toFixed(0)} px · 토글 숨김 ${hiddenAfter}`);
  console.log('errors:', errs.length ? errs : 'none');
  const ok = !vis.hidden && vis.btns === 12 && Math.abs(ang(c0, c1) - 15) < 0.5 && Math.abs(c0.dist - c1.dist) < 1e-3 && c3.dist < c2.dist && c4.dist > c3.dist && dt > 0.05 && ang(c6a, c6) > 16 && folded && after - before > 150 && hiddenAfter && errs.length === 0;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
