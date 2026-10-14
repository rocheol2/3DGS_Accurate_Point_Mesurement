// 지우개 되돌리기·다시 실행: 버튼/단축키, 단계 수 표시, 전체 복원도 되돌리기, 작업 기록 클릭 이동, 새 작업 시 다시 실행 기록 정리,
// 저장한 시점 추적, 지우개를 끈 뒤에도 Ctrl+Z, 측정 중에는 지우개 기록을 건드리지 않음, 붓질 도중 Ctrl+Z, 바뀐 자리 표시
const puppeteer = require('puppeteer-core'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'load' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('gsm.tourSeen', '1'); Object.assign(window.__state.settings, { autoRotate: false, loupeHiRes: false, pickHelpSeen: true }); window.showSaveFilePicker = undefined; });
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const inp = await p.$('#file-input'); await inp.uploadFile(path.join(__dirname, 'layers.ply')); await p.waitForFunction(() => window.__state.file && document.querySelector('#loading').hidden, { timeout: 120000 }); await sleep(300);
  await p.evaluate(() => window.__app.setCamera([1.5, -1.0, 7], [1.5, 1.5, 0.75], [0, 0, 1])); await frame();
  const rect = () => p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top }; });
  const drag = async (v) => { const s = await p.evaluate((v) => window.__app.project(v), v); const r = await rect(); await p.mouse.move(r.l + s.x, r.t + s.y); await p.mouse.down(); await p.mouse.move(r.l + s.x + 2, r.t + s.y, { steps: 2 }); await frame(); await p.mouse.up(); await frame(); };
  const st = () => p.evaluate(() => { const er = window.__state.er; const q = (s) => document.querySelector(s); return { count: er ? er.count : null, undo: er ? er.undo.length : 0, redo: er ? er.redo.length : 0, saved: er ? er.saved : null, rows: document.querySelectorAll('#er-hist li[data-pos]').length, cur: (q('#er-hist li.cur') || {}).dataset?.pos, fut: document.querySelectorAll('#er-hist li.fut').length, undoBtn: q('#er-undo').textContent.trim(), redoBtn: q('#er-redo').textContent.trim(), undoDis: q('#er-undo').disabled, redoDis: q('#er-redo').disabled, mini: !q('#er-mini').hidden, flash: !!window.__state.erFlash, toast: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).pop() || '' }; });
  const key = async (combo) => { const parts = combo.split('+'); for (const k of parts.slice(0, -1)) await p.keyboard.down(k); await p.keyboard.press(parts[parts.length - 1]); for (const k of parts.slice(0, -1).reverse()) await p.keyboard.up(k); await sleep(120); };
  const R = {}; const ok = []; const check = (name, cond, info) => { ok.push([name, !!cond]); console.log(`${cond ? 'OK ' : 'NG '} ${name}`, info === undefined ? '' : JSON.stringify(info)); };

  await p.keyboard.press('e'); await sleep(150); await p.evaluate(() => { document.querySelector('input[name=ermode][value=all]').click(); const el = document.querySelector('#er-size'); el.value = 20; el.dispatchEvent(new Event('input')); });
  const P = [[0.8, 0.8, 1.5], [1.5, 1.5, 1.5], [2.2, 2.2, 1.5], [0.8, 2.2, 1.5]];
  R.s0 = await st(); check('처음: 되돌리기·다시 실행 버튼 비활성, 기록 1줄(처음 상태)', R.s0.undoDis && R.s0.redoDis && R.s0.rows === 1, R.s0);
  const A = []; for (let i = 0; i < 3; i++) { await drag(P[i]); A.push((await st()).count); }
  R.s3 = await st(); check('붓질 3번: 누적 지움 증가, 되돌리기 (3), 기록 4줄, 현재 = 3단계', A[0] > 0 && A[1] > A[0] && A[2] > A[1] && R.s3.undoBtn.includes('(3)') && R.s3.rows === 4 && R.s3.cur === '3', { A, ...R.s3 });
  await p.click('#er-undo'); R.u1 = await st(); await p.screenshot({ path: 'shots/46_eraser_undo.png' }); check('[↶ 되돌리기] 버튼 → 2단계 상태, 다시 실행 (1), 흐린 줄 1, 알림·위치 표시', R.u1.count === A[1] && R.u1.redoBtn.includes('(1)') && R.u1.fut === 1 && /되돌림/.test(R.u1.toast) && /되살림/.test(R.u1.toast) && /점선 상자|화면 밖/.test(R.u1.toast) && R.u1.flash, R.u1);
  await key('Control+z'); R.u2 = await st(); check('Ctrl+Z → 1단계 상태', R.u2.count === A[0] && R.u2.redo === 2, R.u2);
  await key('Control+y'); R.r1 = await st(); check('Ctrl+Y → 2단계 상태 (다시 실행)', R.r1.count === A[1] && /다시 실행/.test(R.r1.toast), R.r1);
  await key('Control+Shift+Z'); R.r2 = await st(); check('Ctrl+Shift+Z → 3단계 상태, 다시 실행 버튼 비활성', R.r2.count === A[2] && R.r2.redoDis, R.r2);
  await p.click('#er-reset'); await sleep(150); R.ra = await st(); check('[전체 복원] → 0개, 기록에 남음(5줄)', R.ra.count === 0 && R.ra.undo === 4 && R.ra.rows === 5, R.ra);
  await key('Control+z'); R.rau = await st(); check('전체 복원도 Ctrl+Z 로 취소 → 다시 3단계 상태', R.rau.count === A[2] && /다시 지움/.test(R.rau.toast), R.rau);
  await p.click('#er-hist li[data-pos="0"]'); await sleep(150); R.j0 = await st(); check('기록에서 "처음 상태" 클릭 → 0개, 다시 실행 4단계', R.j0.count === 0 && R.j0.redo === 4 && R.j0.cur === '0', R.j0);
  await p.click('#er-hist li[data-pos="2"]'); await sleep(150); R.j2 = await st(); R.scroll = await p.evaluate(() => { let moved = 0; for (const el of [document.documentElement, document.body, ...document.querySelectorAll('#gl, #side, #app, main')]) if (el && (el.scrollTop || el.scrollLeft)) moved++; const r = document.querySelector('#gl canvas').getBoundingClientRect(); return { moved, canvasTop: Math.round(r.top), canvasLeft: Math.round(r.left) }; }); check('기록 클릭 뒤 화면이 밀리지 않음', R.scroll.moved === 0, R.scroll); check('기록에서 2단계 클릭 → 2단계 상태로 한 번에', R.j2.count === A[1] && R.j2.undo === 2 && R.j2.redo === 2, R.j2);
  R.hitP3 = await p.evaluate((v) => { const s = window.__app.project(v); const r = document.querySelector('#gl canvas').getBoundingClientRect(); const el = document.elementFromPoint(r.left + s.x, r.top + s.y); return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y), el: el ? (el.id || el.tagName) : null, parent: el && el.parentElement ? (el.parentElement.id || el.parentElement.className) : null }; }, P[3]); R.nToasts = await p.evaluate(() => document.querySelectorAll('#toasts .toast').length); check('되돌리기 알림이 쌓여 3D 화면을 가리지 않음 (붓질 지점 = 3D 화면)', R.hitP3.el !== 'toasts' && R.nToasts <= 2, { ...R.hitP3, toasts: R.nToasts });
  await drag(P[3]); R.n = await st(); check('되돌린 뒤 새 붓질 → 다시 실행 기록 정리, 기록 4줄', R.n.redo === 0 && R.n.rows === 4 && R.n.count > A[1], R.n);
  // 저장한 시점 추적
  await p.evaluate(() => window.__app.openSaveCleaned()); await sleep(200); await p.click('#sv-go'); await p.waitForFunction(() => window.__state.er.saved === true, { timeout: 60000 }); R.sv = await st();
  await key('Control+z'); R.svu = await st(); await key('Control+y'); R.svr = await st();
  check('저장 → 저장됨 / 되돌리면 저장 안 됨 / 다시 실행해 저장 시점으로 오면 다시 저장됨', R.sv.saved && !R.svu.saved && R.svr.saved, [R.sv.saved, R.svu.saved, R.svr.saved]);
  // 붓질 도중 Ctrl+Z: 그 붓질을 마무리하고 바로 되돌림
  { const before = (await st()).count; const s = await p.evaluate(() => window.__app.project([1.2, 1.9, 1.5])); const r = await rect(); await p.mouse.move(r.l + s.x, r.t + s.y); await p.mouse.down(); await p.mouse.move(r.l + s.x + 3, r.t + s.y, { steps: 2 }); await frame(); await key('Control+z'); await p.mouse.up(); await frame(); R.mid = await st(); R.mid.down = await p.evaluate(() => window.__state.er.down); check('붓질 도중 Ctrl+Z → 그 붓질만 취소', R.mid.count === before && !R.mid.down, { before, ...R.mid }); }
  // 지우개를 끈 뒤에도 되돌리기·다시 실행
  await p.keyboard.press('e'); await sleep(150); R.off = await st(); const c0 = R.off.count;
  await key('Control+z'); R.offU = await st(); await p.click('#er-mini-redo'); await sleep(120); R.offR = await st(); await p.click('#er-mini-undo'); await sleep(120); R.offU2 = await st();
  check('지우개를 꺼도 작은 기록 줄 표시 + Ctrl+Z·버튼으로 되돌리기/다시 실행', R.off.mini && R.offU.count < c0 && R.offR.count === c0 && R.offU2.count === R.offU.count, [c0, R.offU.count, R.offR.count, R.offU2.count]);
  await p.keyboard.press('m'); await sleep(120); const cm = (await st()).count; await key('Control+z'); R.task = await st(); await p.keyboard.press('Escape'); await sleep(100);
  check('측정 중에는 Ctrl+Z 가 지우개 기록을 건드리지 않음', R.task.count === cm, { cm, after: R.task.count });
  check('콘솔 오류 없음', !errs.length, errs);
  const pass = ok.every((x) => x[1]); console.log('RESULT:', pass ? 'PASS' : 'FAIL'); await b.close(); process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
