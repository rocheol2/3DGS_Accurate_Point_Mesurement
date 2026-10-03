// 위 방향 판단(헤더 검증·데이터 추정·cameras.json) + 회전 한계 안내 + 뒤집기 + 점군 지연 생성
const puppeteer = require('puppeteer-core'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = '/home/rocheol2/storage/Cesium/data/ds003/';
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 1200000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900', '--js-flags=--max-old-space-size=8192'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.APP_URL, { waitUntil: 'load' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('gsm.tourSeen', '1'); });
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const open = async (...files) => { await p.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); window.__state.file = null; }); const inp = await p.$('#file-input'); await inp.uploadFile(...files); const name = path.basename(files.find((f) => /\.ply$/.test(f))); await p.waitForFunction((n) => window.__state.file && window.__state.file.name === n && document.querySelector('#loading').hidden, { timeout: 300000 }, name); await sleep(300);
    return p.evaluate(() => ({ up: document.querySelector('#up-label').textContent, src: window.__state.upSource, est: window.__state.upEstimate && { flat: +window.__state.upEstimate.flat.toFixed(3), A: +window.__state.upEstimate.A.toFixed(2), conf: window.__state.upEstimate.confident }, toasts: Array.from(document.querySelectorAll('.toast .code')).map((t) => t.textContent.slice(0, 3)), pts3: !!window.__state.points3 })); };
  const R = {}; const log = (k, r) => { R[k] = r; console.log(`${k}: 위=${r.up} | 출처=${r.src} | 분석=${JSON.stringify(r.est)} | 알림=${r.toasts.join(',')}`); };
  log('정육면체 헤더 +Z(맞음)', await open(path.join(__dirname, 'cube_m.ply')));
  log('정육면체 헤더 −Z(틀림)', await open(path.join(__dirname, 'cube_wronghdr.ply')));
  log('정육면체 헤더 없음', await open(path.join(__dirname, 'cube.ply')));
  log('DS003 헤더 +Z(틀린 옛 헤더)', await open(path.join(__dirname, 'ds003_wrong_header.ply')));
  log('DS003 옛 헤더 + cameras.json', await open(path.join(__dirname, 'ds003_wrong_header.ply'), path.join(__dirname, 'ds003_cameras.json')));
  const fixed = await open(D + 'ds003_cm002_local_metric_1p5M_sh0.ply'); log('DS003 고친 헤더 −Z', fixed);
  console.log('  점군 지연 생성: 스플랫 보기에서 점군 객체 존재 =', fixed.pts3);
  await p.keyboard.press('Tab'); await sleep(1500); const built = await p.evaluate(() => ({ pts3: !!window.__state.points3, n: window.__state.denseInfo?.total })); console.log('  Tab 후 점군 생성 =', JSON.stringify(built)); await p.keyboard.press('Tab'); await sleep(300);
  await p.screenshot({ path: 'shots/40_ds003_upright.png' });
  log('DS003 CM001 절대좌표(헤더 없음)', await open(D + 'ds003_cm001_abs_800k_sh0.ply'));
  // 회전 한계 안내: 정육면체에 일부러 틀린 위(−Z)를 주고 화면을 바로 세우려 위로 드래그
  await open(path.join(__dirname, 'cube_m.ply')); await p.evaluate(() => { window.__app.setUpAxis([0, 0, -1]); document.querySelectorAll('.toast').forEach((t) => t.remove()); }); await frame();
  const r = await p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top, w: q.width, h: q.height }; });
  await p.mouse.move(r.l + r.w / 2, r.t + r.h - 40); await p.mouse.down(); await p.mouse.move(r.l + r.w / 2, r.t + 40, { steps: 25 }); await frame(); await p.mouse.up();
  const pole = await p.evaluate(() => { const off = window.__app.camera.position.clone().sub(window.__app.controls.target); return { phiDeg: +(Math.acos(off.dot(window.__app.camera.up) / off.length()) * 180 / Math.PI).toFixed(1), hint: Array.from(document.querySelectorAll('.toast b')).map((t) => t.textContent).find((t) => t.includes('회전 한계')) || null }; });
  console.log(`회전 한계: 극각 ${pole.phiDeg}° | 안내 = ${pole.hint}`); await p.screenshot({ path: 'shots/41_pole_hint.png' });
  await p.keyboard.press('u'); await frame(); const flipped = await p.evaluate(() => document.querySelector('#up-label').textContent); console.log('U 키 뒤집기 후 위 =', flipped);
  console.log('errors:', errs.length ? errs : 'none');
  const ok = R['정육면체 헤더 +Z(맞음)'].up === '+Z' && !R['정육면체 헤더 +Z(맞음)'].toasts.includes('E15') && R['정육면체 헤더 −Z(틀림)'].up === '+Z' && R['정육면체 헤더 −Z(틀림)'].toasts.includes('E15') && R['정육면체 헤더 없음'].up === '+Z'
    && R['DS003 헤더 +Z(틀린 옛 헤더)'].up === '−Z' && R['DS003 헤더 +Z(틀린 옛 헤더)'].toasts.includes('E15') && R['DS003 옛 헤더 + cameras.json'].up === '−Z' && /카메라/.test(R['DS003 옛 헤더 + cameras.json'].src)
    && R['DS003 고친 헤더 −Z'].up === '−Z' && !R['DS003 고친 헤더 −Z'].toasts.includes('E15') && !fixed.pts3 && built.pts3 && R['DS003 CM001 절대좌표(헤더 없음)'].up === '−Z' && pole.hint && flipped === '+Z' && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
