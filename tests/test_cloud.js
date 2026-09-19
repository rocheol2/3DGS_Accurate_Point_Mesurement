// 점군 보기 + 1클릭 직접 선택(군집/최근접) + 설명 창 + 정밀화 + Shift 클릭
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); Object.assign(window.__state.settings, { autoRotate: false, loupeHiRes: false, pickHelpSeen: false }); });
  const buf = fs.readFileSync(path.join(__dirname, 'cube_m.ply'));
  const t0 = Date.now(); await p.evaluate(async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); await window.__app.loadArrayBuffer('cube_m.ply', u8.buffer); }, buf.toString('base64')); await sleep(600);
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const cl = await p.evaluate(() => ({ n: window.__state.cloud?.n, has3: !!window.__state.points3, mode: window.__state.settings.viewMode, meshVis: window.__state.mesh.visible, ptsVis: window.__state.points3?.visible }));
  console.log(`로드 ${((Date.now() - t0) / 1000).toFixed(1)} s | 점군 ${cl.n}점 | 초기 보기 ${cl.mode} (mesh ${cl.meshVis}, points ${cl.ptsVis})`);
  await p.keyboard.press('Tab'); await frame(); await frame();
  const v1 = await p.evaluate(() => ({ mode: window.__state.settings.viewMode, meshVis: window.__state.mesh.visible, ptsVis: window.__state.points3.visible, label: document.querySelector('#view-label').textContent }));
  const lit = await p.evaluate(() => { let n = 0; for (const [x, y] of [[530, 400], [450, 350], [600, 450]]) { const c = window.__app.pixel(x, y); if (c[0] + c[1] + c[2] > 60) n++; } return n; });
  console.log(`Tab → ${JSON.stringify(v1)} | 점군 렌더 표본 밝은 픽셀 ${lit}/3`); await p.screenshot({ path: 'shots/28_cloud_view.png' });
  // 직접 선택: 꼭짓점 (2,2,2) — 군집 중앙값
  await p.evaluate((v) => window.__app.setCamera([5.5, 5.0, 4.0], v, [0, 0, 1]), [2, 2, 2]); await frame();
  const r = await p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top }; });
  await p.evaluate(() => window.__app.startTask('point'));
  const s = await p.evaluate(() => window.__app.project([2, 2, 2])); await p.mouse.click(r.l + s.x, r.t + s.y); await sleep(300);
  const pick1 = await p.evaluate(() => { const q = window.__state.points[0]; return q && { p: q.p.toArray(), sigma: q.sigma0, n: q.n, method: q.method, mode: q.pickMode, quality: q.quality, helpOpen: !document.querySelector('#modal').hidden, helpTitle: document.querySelector('#modal h2')?.textContent }; });
  const e1 = Math.hypot(pick1.p[0] - 2, pick1.p[1] - 2, pick1.p[2] - 2);
  console.log(`군집 중앙값 선택: 오차 ${(e1 * 1000).toFixed(1)} mm · σ ${(pick1.sigma * 1000).toFixed(1)} mm · 군집 ${pick1.n}점 · ${pick1.method}/${pick1.mode}/${pick1.quality} · 설명창 처음 표시 ${pick1.helpOpen} (${pick1.helpTitle})`);
  await p.screenshot({ path: 'shots/29_pick_help.png' }); await p.evaluate(() => document.querySelector('#pick-help-ok').click());
  // 최근접 방식
  await p.evaluate(() => { window.__state.settings.pickMode = 'nearest'; }); await p.mouse.click(r.l + s.x + 1, r.t + s.y); await sleep(300);
  const pick2 = await p.evaluate(() => { const q = window.__state.points[1]; return q && { p: q.p.toArray(), n: q.n, mode: q.pickMode }; }); const e2 = Math.hypot(pick2.p[0] - 2, pick2.p[1] - 2, pick2.p[2] - 2);
  console.log(`가장 가까운 점 하나: 오차 ${(e2 * 1000).toFixed(1)} mm · n ${pick2.n} · ${pick2.mode}`);
  // 잡티 상황: 꼭짓점 앞 0.5 m 지점에 외톨이 점 2개를 점군에 심고 다시 선택 (군집 방식은 무시해야 함)
  await p.evaluate(() => { window.__state.settings.pickMode = 'cluster'; const cl = window.__state.cloud; const c = window.__app.camera.position; const dir = new window.__app.THREE.Vector3(2, 2, 2).sub(c).normalize(); const fl = new window.__app.THREE.Vector3(2, 2, 2).addScaledVector(dir, -0.5); for (let k = 0; k < 2; k++) { cl.pos[3 * k] = fl.x + k * 0.001; cl.pos[3 * k + 1] = fl.y; cl.pos[3 * k + 2] = fl.z; } });
  await p.mouse.click(r.l + s.x, r.t + s.y); await sleep(300);
  const pick3 = await p.evaluate(() => { const q = window.__state.points[2]; return q && q.p.toArray(); }); const e3 = Math.hypot(pick3[0] - 2, pick3[1] - 2, pick3[2] - 2);
  await p.evaluate(() => { window.__state.settings.pickMode = 'nearest'; }); await p.mouse.click(r.l + s.x, r.t + s.y); await sleep(300);
  const pick4 = await p.evaluate(() => { const q = window.__state.points[3]; return q && q.p.toArray(); }); const e4 = Math.hypot(pick4[0] - 2, pick4[1] - 2, pick4[2] - 2);
  console.log(`잡티(0.5 m 앞) 2점 삽입 후 — 군집: 오차 ${(e3 * 1000).toFixed(1)} mm (무시 기대) · 최근접: 오차 ${(e4 * 1000).toFixed(0)} mm (잡티를 찍을 수 있음)`);
  // Shift+클릭 → 다시점 광선
  await p.evaluate(() => { window.__state.settings.pickMode = 'cluster'; }); await p.keyboard.down('Shift'); await p.mouse.click(r.l + s.x, r.t + s.y); await p.keyboard.up('Shift'); await sleep(200);
  const rays = await p.evaluate(() => window.__state.rays.length); console.log('Shift+클릭 → 광선 수', rays, '(1 기대)'); await p.keyboard.press('Escape'); await sleep(100);
  // 정밀화: 점 P1 을 5시점 클릭으로 교체
  await p.evaluate(() => window.__app.endTask()); await p.evaluate((id) => window.__app.startRefine(id), 1); await sleep(400);
  const poses = [[5.5, 5.0, 4.0], [4.0, 6.5, 3.5], [6.5, 3.5, 3.0], [5.0, 4.5, 6.0], [3.5, 5.5, 5.0]];
  for (const pose of poses) { await p.evaluate((pos, tgt) => window.__app.setCamera(pos, tgt, [0, 0, 1]), pose, [2, 2, 2]); await sleep(250); const sp = await p.evaluate(() => window.__app.project([2, 2, 2])); await p.evaluate((x, y) => window.__app.click(x, y), sp.x, sp.y); await sleep(250); }
  await sleep(200); const ref = await p.evaluate(() => { const q = window.__state.points.find((z) => z.id === 1); return { name: q.name, method: q.method, quality: q.quality, p: q.p.toArray(), n: q.n, count: window.__state.points.length, task: !!window.__state.task }; });
  const e5 = Math.hypot(ref.p[0] - 2, ref.p[1] - 2, ref.p[2] - 2); console.log(`정밀화: ${ref.name} → ${ref.method}/${ref.quality}, 광선 ${ref.n}, 오차 ${(e5 * 1000).toFixed(1)} mm, 점 개수 유지 ${ref.count} (4 기대), 작업 종료 ${!ref.task}`);
  await p.evaluate(() => document.querySelector('.tab[data-tab="results"]').click()); await frame(); await p.screenshot({ path: 'shots/30_pick_results.png' });
  const csv = await p.evaluate(() => { const s2 = window.__state; return s2.points.map((q) => q.method).join(','); }); console.log('method:', csv, '| errors:', errs.length ? errs : 'none');
  const ok = cl.n > 40000 && v1.mode === 'cloud' && v1.ptsVis && !v1.meshVis && lit >= 2 && e1 < 0.01 && pick1.helpOpen && pick1.method === 'pick' && e2 < 0.02 && e3 < 0.01 && rays === 1 && ref.method === 'multi' && e5 < 0.01 && ref.count === 4 && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
