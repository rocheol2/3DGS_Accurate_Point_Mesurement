// 1단계 분석: 각도·길이·면적(기존 점 마커 클릭 재사용 흐름), 수평/고저차/경사, 오차 전파, 결과 표·오버레이
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); window.__state.settings.autoRotate = false; window.__state.settings.loupeHiRes = false; });
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(600);
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // 점: 윗면 4꼭짓점 + 바닥 1점 (공분산 1e-8 → σ≈1e-4)
  await p.evaluate(() => { for (const v of [[0, 2, 2], [2, 2, 2], [2, 0, 2], [0, 0, 2], [0, 0, 0]]) window.__app.debugAddPoint(v); window.__app.setCamera([5, 5, 6], [1, 1, 1.5], [0, 0, 1]); });
  await frame();
  const r = await p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top }; });
  const clickPt = async (name) => { const s = await p.evaluate((n) => { const pt = window.__state.points.find((q) => q.name === n); return window.__app.project(pt.p); }, name); await p.mouse.click(r.l + s.x, r.t + s.y); await sleep(150); };
  // 각도: A=P1(0,2,2), B=P2(2,2,2) 꼭짓점, C=P3(2,0,2) → 90°
  await p.keyboard.press('a'); await clickPt('P1'); await clickPt('P2'); await clickPt('P3'); await sleep(200);
  const g1 = await p.evaluate(() => { const g = window.__state.geoms[0]; return g && { type: g.type, ...window.__app.geomInfo(g), pts: undefined }; }); console.log('각도:', g1 && g1.type, g1 && g1.text, '| 작업 종료:', await p.evaluate(() => !window.__state.task));
  // 길이: P1→P2→P3 = 4.000
  await p.keyboard.press('l'); await clickPt('P1'); await clickPt('P2'); await clickPt('P3'); const before = await p.evaluate(() => document.querySelector('#btn-geom-finish').disabled); await p.keyboard.press('Enter'); await sleep(200);
  const g2 = await p.evaluate(() => { const g = window.__state.geoms[1]; return g && { type: g.type, ...window.__app.geomInfo(g), pts: undefined }; }); console.log('길이:', g2 && g2.type, g2 && g2.text, '| 완성 버튼 활성:', !before);
  // 면적: P1→P2→P3→P4 = 4.000 m², 둘레 8, 기울기 0
  await p.keyboard.press('p'); for (const n of ['P1', 'P2', 'P3', 'P4']) await clickPt(n); await p.keyboard.press('Enter'); await sleep(200);
  const g3 = await p.evaluate(() => { const g = window.__state.geoms[2]; const gi = window.__app.geomInfo(g); return g && { type: g.type, main: gi.main, sigma: gi.sigma, text: gi.text, extra: gi.extra, per: gi.per, tilt: gi.tilt, ah: gi.ah }; }); console.log('면적:', g3 && g3.type, g3 && g3.text, '|', g3 && g3.extra);
  // 수평/고저차/경사: P5(0,0,0)–P3(2,0,2)
  const dd = await p.evaluate(() => { const a = window.__state.points.find((q) => q.name === 'P5'), c = window.__state.points.find((q) => q.name === 'P3'); const d = window.__app.distanceDecomp(a, c); return { d: d.d, h: d.h, v: d.v, slope: d.slopeDeg, pct: d.slopePct, sh: d.sigmaH }; }); console.log('거리 분해 P5–P3:', JSON.stringify(dd));
  await p.evaluate(() => { const a = window.__state.points.find((q) => q.name === 'P5'), c = window.__state.points.find((q) => q.name === 'P3'); document.querySelector(`[data-sel="${a.id}"]`).click(); document.querySelector(`[data-sel="${c.id}"]`).click(); document.querySelector('#btn-dist-sel').click(); document.querySelector('.tab[data-tab="results"]').click(); });
  await frame(); const rows = await p.evaluate(() => ({ geomRows: document.querySelectorAll('#geom-table tbody tr').length, distRow: document.querySelector('#dist-table tbody tr').innerText.replace(/\s+/g, ' ').slice(0, 90) })); console.log('표:', JSON.stringify(rows));
  await p.screenshot({ path: 'shots/27_analysis.png' });
  // 중복 선택 방지 + 점 삭제 시 분석 항목 제거
  await p.keyboard.press('a'); await clickPt('P1'); await clickPt('P1'); const dup = await p.evaluate(() => window.__state.task.pts.length); await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.evaluate(() => { const a = window.__state.points.find((q) => q.name === 'P4'); document.querySelector(`[data-del="${a.id}"]`).click(); }); const left = await p.evaluate(() => window.__state.geoms.length);
  console.log(`중복 클릭 후 선택 수 ${dup} (1 기대) · P4 삭제 후 분석 항목 ${left}개 (면적만 제거 → 2 기대) · errors: ${errs.length ? errs : 'none'}`);
  const ok = g1 && Math.abs(g1.main - 90) < 0.01 && g2 && Math.abs(g2.main - 4) < 1e-3 && g3 && Math.abs(g3.main - 4) < 1e-3 && Math.abs(g3.per - 8) < 1e-3 && g3.tilt < 0.01 && Math.abs(dd.d - Math.SQRT2 * 2) < 1e-3 && Math.abs(dd.h - 2) < 1e-3 && Math.abs(dd.v - 2) < 1e-3 && Math.abs(dd.slope - 45) < 0.01 && rows.geomRows === 3 && dup === 1 && left === 2 && Number.isFinite(g1.sigma) && g1.sigma > 0 && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
