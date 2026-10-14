// 지우개: 도구막대 폭, 세 가지 깊이 방식, 되돌리기/다시/전체 복원, 점군 반영, 원본 그대로 저장(큰 좌표 포함), 변환 저장, 다시 열기
const puppeteer = require('puppeteer-core'); const path = require('path'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto(process.env.APP_URL || 'http://127.0.0.1:8765/index.html#notour', { waitUntil: 'load' }); await p.waitForFunction(() => window.__app);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('gsm.tourSeen', '1'); Object.assign(window.__state.settings, { autoRotate: false, loupeHiRes: false, pickHelpSeen: true }); window.showSaveFilePicker = undefined; });
  const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const open = async (f) => { await p.evaluate(() => { window.__state.file = null; }); const inp = await p.$('#file-input'); await inp.uploadFile(path.join(__dirname, f)); await p.waitForFunction((n) => window.__state.file && window.__state.file.name === n && document.querySelector('#loading').hidden, { timeout: 120000 }, f); await sleep(300); };
  const R = {}; const rect = () => p.evaluate(() => { const q = document.querySelector('#gl canvas').getBoundingClientRect(); return { l: q.left, t: q.top }; });
  const pix = (v) => p.evaluate(async (v) => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); window.__app.render(); const s = window.__app.project(v); return window.__app.pixel(s.x, s.y); }, v);
  const erased = () => p.evaluate(() => { const er = window.__state.er, P = window.__state.cloud.all.pos; const out = { count: er.count, nearV: 0, floorFar: 0, last6: 0, N: er.mask.length }; for (let i = 0; i < er.mask.length; i++) if (er.mask[i]) { const d = Math.hypot(P[3 * i] - 2, P[3 * i + 1] - 2, P[3 * i + 2] - 2); if (d < 0.6) out.nearV++; if (P[3 * i + 2] < 0.1 && d > 1.5) out.floorFar++; if (i >= er.mask.length - 6) out.last6++; } return out; });
  const drag = async (v, dx = 4) => { const s = await p.evaluate((v) => window.__app.project(v), v); const r = await rect(); await p.mouse.move(r.l + s.x, r.t + s.y); await p.mouse.down(); await p.mouse.move(r.l + s.x + dx, r.t + s.y, { steps: 3 }); await frame(); await p.mouse.up(); await frame(); };
  const setMode = (m, size) => p.evaluate((m, size) => { document.querySelector(`input[name=ermode][value=${m}]`).click(); const el = document.querySelector('#er-size'); el.value = size; el.dispatchEvent(new Event('input')); }, m, size);

  // ---- A. 도구막대가 창 폭 안에 들어오는가 (1400, 1280)
  await open('cube_floaters.ply');
  for (const w of [1400, 1280]) { await p.setViewport({ width: w, height: 900 }); await sleep(200); R['bar' + w] = await p.evaluate(() => { let mx = 0; document.querySelectorAll('#topbar .btn').forEach((e) => { mx = Math.max(mx, e.getBoundingClientRect().right); }); return { right: Math.round(mx), win: window.innerWidth }; }); }
  await p.setViewport({ width: 1400, height: 900 }); await sleep(200);
  console.log(`A 도구막대: 1400 → 맨 오른쪽 ${R.bar1400.right}/${R.bar1400.win}, 1280 → ${R.bar1280.right}/${R.bar1280.win}`);

  // ---- B. 지우개 켜기
  await p.evaluate(() => window.__app.setCamera([5.5, 5.0, 4.0], [2, 2, 2], [0, 0, 1])); await frame();
  await p.keyboard.press('e'); await sleep(200);
  R.on = await p.evaluate(() => ({ panel: !document.querySelector('#eraser-panel').hidden, left: window.__app.controls.mouseButtons.LEFT, idleHidden: document.querySelector('#measure-idle').hidden, N: window.__state.er && window.__state.er.mask.length }));
  console.log('B 지우개 켬:', JSON.stringify(R.on));

  // ---- C. 꼭짓점 표식 지우기 (보이는 층) → 화면에서 사라짐
  await setMode('front', 14); const c0 = await pix([2, 2, 2]); await drag([2, 2, 2]); R.front = await erased(); const c1 = await pix([2, 2, 2]);
  console.log(`C 표식 지우기: 지움 ${R.front.count} (꼭짓점 근처 ${R.front.nearV}) | 표식 픽셀 ${c0.slice(0, 3)} → ${c1.slice(0, 3)}`);
  await p.screenshot({ path: 'shots/42_eraser_front.png' });
  // ---- D. 되돌리기 / 다시
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); await sleep(150); R.undo = await erased(); const c2 = await pix([2, 2, 2]);
  await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.press('z'); await p.keyboard.up('Shift'); await p.keyboard.up('Control'); await sleep(150); R.redo = await erased();
  console.log(`D 되돌리기 → 지움 ${R.undo.count}, 표식 픽셀 ${c2.slice(0, 3)} | 다시 → 지움 ${R.redo.count}`);
  await p.evaluate(() => window.__app.erRestoreAll()); R.restored = (await erased()).count;
  // ---- E. 깊이 방식 비교: 큰 잡티 6개가 정육면체·바닥을 가리는 자리에서 같은 붓질
  await p.evaluate(() => window.__app.setCamera([1, -3.5, 8], [1, 1, 3.2], [0, 0, 1])); await frame(); const f0 = await pix([1, 1, 3.2]);
  R.undoBeforeE = await p.evaluate(() => window.__state.er.undo.length);
  await setMode('front', 30); await drag([1, 1, 3.2], 3); R.lay = await erased();
  await drag([1, 1, 3.2], 3); R.lay2 = await erased(); R.marks = await p.evaluate(() => { const m = window.__state.er.mask; let two = 0; for (let i = 0; i < m.length; i++) if (m[i] === 2) two++; return { two, undo: window.__state.er.undo.length }; });
  await p.evaluate(() => window.__app.erUndo()); R.lay2u = await erased(); await p.evaluate(() => window.__app.erRestoreAll());
  await setMode('all', 30); await drag([1, 1, 3.2], 3); R.all = await erased(); await p.evaluate(() => window.__app.erRestoreAll());
  console.log(`E 보이는 층만: 지움 ${R.lay.count} (잡티 ${R.lay.last6}/6) → 뒤의 정육면체·바닥은 남음 | 전부(관통): 지움 ${R.all.count} (잡티 ${R.all.last6}/6, 나머지 ${R.all.count - R.all.last6}개는 뒤의 것)`);
  console.log(`E2 같은 자리 두 번째 붓질: 지움 ${R.lay2.count} (뒤 층 ${R.lay2.count - R.lay.count}개 추가) | 붓질 기록 +${R.marks.undo - R.undoBeforeE}단계(전체 ${R.marks.undo}), 임시표시 남음 ${R.marks.two} | 한 번 되돌리기 → ${R.lay2u.count}`);
  // ---- E3. 붓질 도중(마우스를 떼기 전) Esc 로 지우개를 꺼도 그 붓질이 기록되어 되돌릴 수 있는가
  { await setMode('front', 30); const s3 = await p.evaluate(() => window.__app.project([1, 1, 3.2])); const r3 = await rect(); await p.mouse.move(r3.l + s3.x, r3.t + s3.y); await p.mouse.down(); await p.mouse.move(r3.l + s3.x + 3, r3.t + s3.y, { steps: 3 }); await frame(); await p.keyboard.press('Escape'); await sleep(100);
    R.mid = await p.evaluate(() => { const er = window.__state.er; let two = 0; for (let i = 0; i < er.mask.length; i++) if (er.mask[i] === 2) two++; return { eraser: window.__state.eraser, count: er.count, undo: er.undo.length, two, down: er.down }; });
    await p.mouse.up(); await p.keyboard.press('e'); await sleep(150); await p.evaluate(() => window.__app.erUndo()); R.mid.afterUndo = (await erased()).count; }
  console.log('E3 붓질 도중 Esc:', JSON.stringify(R.mid));
  // ---- F. 큰 가우시안만: 넓은 붓으로 문질러도 잡티 6개만 지워져야 함
  await setMode('big', 70); await drag([1, 1, 3.2], 6); R.big = await erased(); const f1 = await pix([1, 1, 3.2]);
  console.log(`F 큰 가우시안만(붓 70 px): 지움 ${R.big.count} (그중 잡티 ${R.big.last6}/6) | 잡티 자리 픽셀 ${f0.slice(0, 3)} → ${f1.slice(0, 3)}`);
  await p.screenshot({ path: 'shots/43_eraser_big.png' });
  // ---- G. 원본 그대로 저장 → 검증 → 다시 열기
  R.save = await p.evaluate(async () => { const A = window.__app, st = window.__state; const blob = await A.cleanedBlob(false); const buf = await blob.arrayBuffer(); const u8 = new Uint8Array(buf); let text = ''; for (let i = 0; i < 2500; i++) text += String.fromCharCode(u8[i]); const hl = text.indexOf('end_header\n') + 11; const head = text.slice(0, hl); const n = +/element vertex (\d+)/.exec(head)[1]; const k = (head.match(/property float/g) || []).length;
    const orig = new Uint8Array(await st.srcFile.arrayBuffer()); const ohl = st.header.headerLength; let same = true; for (let i = 0; i < 68 * 1000; i++) if (u8[hl + i] !== orig[ohl + i]) { same = false; break; }   // 앞 1000행은 지우지 않았으므로 원본과 같아야 함
    const f = new Float32Array(buf.slice(hl)); const is0 = head.split('\n').filter((l) => l.startsWith('property')).findIndex((l) => l.endsWith('scale_0')); let bigLeft = 0; for (let i = 0; i < n; i++) if (Math.exp(f[i * k + is0]) > 0.3) bigLeft++;
    return { exact: A.canExactSave(), n, expect: st.er.mask.length - st.er.count, sizeOk: buf.byteLength === hl + n * k * 4, unitsKept: /comment units: meters/.test(head), noted: /comment cleaned with 3DGS measurer eraser: removed 6 of/.test(head), first1000Same: same, bigLeft, b64len: buf.byteLength }; });
  console.log('G 저장(원본 그대로):', JSON.stringify(R.save));
  R.reopen = await p.evaluate(async () => { const A = window.__app; const buf = await (await A.cleanedBlob(false)).arrayBuffer(); await A.loadArrayBuffer('cube_floaters_cleaned.ply', buf); return { count: window.__state.file.count, unit: window.__state.unit.known, er: window.__state.er, eraser: window.__state.eraser, up: document.querySelector('#up-label').textContent }; }); await sleep(300);
  console.log('  저장 파일 다시 열기:', JSON.stringify(R.reopen));
  // ---- H. 큰 좌표 파일: 저장 좌표가 원래 값인지 (비트 단위 비교)
  await open('cube_big.ply'); await p.keyboard.press('e'); await sleep(150);
  const Vb = await p.evaluate(() => { const o = window.__state.coordOffset; return [285891.063 - o[0], 121062.398 - o[1], 42 - o[2]]; });
  await p.evaluate((v) => window.__app.setCamera([v[0] + 3.5, v[1] + 3, v[2] + 2], v, [0, 0, 1]), Vb); await frame(); await setMode('front', 14); await drag(Vb);
  R.bigc = await p.evaluate(async () => { const A = window.__app, st = window.__state; const buf = await (await A.cleanedBlob(false)).arrayBuffer(); const u8 = new Uint8Array(buf); let text = ''; for (let i = 0; i < 2500; i++) text += String.fromCharCode(u8[i]); const hl = text.indexOf('end_header\n') + 11; const n = +/element vertex (\d+)/.exec(text)[1];
    const orig = new Uint8Array(await st.srcFile.arrayBuffer()), ohl = st.header.headerLength, mask = st.er.mask, stride = 68; let o = 0, same = true; for (let i = 0; i < mask.length && same; i++) { if (mask[i]) continue; for (let q = 0; q < stride; q++) if (u8[hl + o * stride + q] !== orig[ohl + i * stride + q]) { same = false; break; } o++; }
    const f = new Float32Array(buf.slice(hl, hl + 68)); return { offset: st.coordOffset, erased: st.er.count, n, rowsCompared: o, allKeptRowsBitExact: same, firstX: f[0] }; });
  console.log('H 큰 좌표 저장:', JSON.stringify(R.bigc));
  // ---- I. 변환 저장(SH0) 강제 → 다시 열기
  await open('cube_m.ply'); await p.evaluate(() => window.__app.setCamera([5.5, 5.0, 4.0], [2, 2, 2], [0, 0, 1])); await frame(); await p.keyboard.press('e'); await sleep(150); await setMode('front', 14); await drag([2, 2, 2]); const erI = await erased();
  // ---- J. 점군 보기 반영 + 직접 선택에서 제외
  await p.keyboard.press('Tab'); await sleep(600); R.cloud = await p.evaluate(() => { const st = window.__state; const a = st.points3.geometry.getAttribute('vis').array; let z = 0; for (let i = 0; i < a.length; i++) if (!a[i]) z++; const s = window.__app.project([2, 2, 2]); const pk = window.__app.directPick(s.x, s.y); return { hiddenSamples: z, K: st.points3.userData.K, erased: st.er.count, pickDist: pk ? Math.hypot(pk.p.x - 2, pk.p.y - 2, pk.p.z - 2) : null }; });
  console.log(`J 점군: 숨긴 표본 ${R.cloud.hiddenSamples} (지움 ${R.cloud.erased} × ${R.cloud.K}) | 직접 선택이 지운 꼭짓점을 피함: 거리 ${R.cloud.pickDist == null ? '없음' : R.cloud.pickDist.toFixed(3)}`);
  await p.keyboard.press('Tab'); await sleep(200);
  R.fb = await p.evaluate(async () => { const A = window.__app, st = window.__state; const want = st.er.mask.length - st.er.count; const buf = await (await A.cleanedBlob(true)).arrayBuffer(); await A.loadArrayBuffer('cube_sh0.ply', buf); const P = window.__state.cloud.all.pos; let near = 0; for (let i = 0; i < P.length; i += 3) if (Math.hypot(P[i] - 2, P[i + 1] - 2, P[i + 2] - 2) < 0.05) near++; return { want, got: window.__state.file.count, markerLeft: near, sh: window.__state.header.shDegree }; }); await sleep(300);
  console.log('I 변환 저장(SH0) 다시 열기:', JSON.stringify(R.fb), '| 지웠던 개수', erI.count);
  // ---- L. 층 수 선택: 불투명한 평면 4겹(z = 0, 0.5, 1.0, 1.5)을 비스듬히 내려다보며 같은 자리를 한 번씩 문질러 겹별로 지워진 수를 센다
  await open('layers.ply'); await p.evaluate(() => window.__app.setCamera([1.5, -1.0, 7], [1.5, 1.5, 0.75], [0, 0, 1])); await frame(); await p.keyboard.press('e'); await sleep(150);
  const byLayer = () => p.evaluate(() => { const m = window.__state.er.mask, o = [0, 0, 0, 0]; for (let i = 0; i < m.length; i++) if (m[i]) o[Math.floor(i / 6000)]++; return o.reverse(); });   // [맨 위 겹, 둘째, 셋째, 맨 아래]
  const setLayers = (n) => p.evaluate((n) => { const el = document.querySelector('#er-layers'); el.value = n; el.dispatchEvent(new Event('input')); }, n);
  R.L = {}; const tgt = [1.5, 1.5, 0.75];
  await setMode('all', 25); await drag(tgt, 2); R.L.all = await byLayer(); await p.evaluate(() => window.__app.erRestoreAll());
  await setMode('front', 25); await drag(tgt, 2); R.L.l1 = await byLayer(); await p.evaluate(() => window.__app.erRestoreAll());
  for (const n of [2, 3, 4, 10]) { await setLayers(n); R.L['l' + n] = await byLayer(); R.L['mode' + n] = await p.evaluate(() => window.__state.settings.erMode + window.__state.settings.erLayers); await drag(tgt, 2); R.L['l' + n] = await byLayer(); if (n === 2) await p.screenshot({ path: 'shots/44_eraser_layers.png' }); await p.evaluate(() => window.__app.erRestoreAll()); }
  { const off = [0.7, 2.3, 1.5]; const so = await p.evaluate((v) => window.__app.project(v), off); R.L.offPx = [Math.round(so.x - 700), Math.round(so.y - 450)]; R.L.off = {};
    await setMode('all', 25); await drag(off, 2); R.L.off.all = await byLayer(); await p.evaluate(() => window.__app.erRestoreAll());
    await setMode('front', 25); await drag(off, 2); R.L.off.l1 = await byLayer(); await p.evaluate(() => window.__app.erRestoreAll());
    for (const n of [2, 3]) { await setLayers(n); await drag(off, 2); R.L.off['l' + n] = await byLayer(); await p.evaluate(() => window.__app.erRestoreAll()); } }
  // 숫자 키: 3 → 여러 층 3, 1 → 보이는 층, 0 → 전부, B → 큰 것만 / 설명 그림
  const modeNow = () => p.evaluate(() => { const st = window.__state.settings; return { m: st.erMode, n: st.erLayers, on: [...document.querySelectorAll('#eraser-panel .opt.on')].map((e) => e.id).join(','), label: document.querySelector('#er-layers-label').textContent, svg: !!document.querySelector('#er-diagram svg'), gone: (document.querySelector('#er-diagram').innerHTML.match(/✕<\/text>/g) || []).length }; });
  R.keys = {}; for (const k of ['3', '1', '0', 'b', '5']) { await p.keyboard.press(k); await sleep(60); R.keys[k] = await modeNow(); }
  // 3층으로 지운 뒤 같은 자리를 한 번 더 → 남은 한 겹이 지워짐, 붓질 단위로 되돌려짐
  await setLayers(3); await drag(tgt, 2); const a3 = await byLayer(); await drag(tgt, 2); const a4 = await byLayer(); await p.evaluate(() => window.__app.erUndo()); const a3u = await byLayer(); R.L.again = { a3, a4, a3u }; await p.evaluate(() => window.__app.erRestoreAll());
  console.log(`L 층 수 선택 (겹별 지운 수 [위→아래]): 전부 ${R.L.all} | 1층 ${R.L.l1} | 2층 ${R.L.l2} | 3층 ${R.L.l3} | 4층 ${R.L.l4} | 10층 ${R.L.l10}`);
  console.log(`  3층 후 다시 한 번: ${a3} → ${a4} → 되돌리기 ${a3u} | 키: 3→${R.keys['3'].m}${R.keys['3'].n} 1→${R.keys['1'].m} 0→${R.keys['0'].m} b→${R.keys['b'].m} 5→${R.keys['5'].m}${R.keys['5'].n} | 그림 ✕ 수 3층 ${R.keys['3'].gone} 1층 ${R.keys['1'].gone} 전부 ${R.keys['0'].gone} 큰것 ${R.keys['b'].gone}`);
  console.log(`  화면 중앙에서 ${R.L.offPx} px 벗어난 자리: 전부 ${R.L.off.all} | 1층 ${R.L.off.l1} | 2층 ${R.L.off.l2} | 3층 ${R.L.off.l3}`);
  // 정한 겹까지는 '전부' 방식과 같은 수(90 % 이상), 그 뒤 겹은 0 (붓 가장자리에서 앞 겹이 성긴 칸으로 한두 개 비쳐 보이는 것은 허용: 3 % 이하)
  const onlyOf = (all) => (arr, n) => arr.every((v, k) => (k < n ? v >= 0.9 * all[k] && v <= all[k] : v <= Math.max(2, 0.03 * all[k]))); const only = onlyOf(R.L.all), onlyOff = onlyOf(R.L.off.all);
  R.Lok = R.L.all.every((v) => v > 10) && Math.hypot(...R.L.offPx) > 150 && R.L.off.all.every((v) => v > 10) && onlyOff(R.L.off.l1, 1) && onlyOff(R.L.off.l2, 2) && onlyOff(R.L.off.l3, 3) && only(R.L.l1, 1) && only(R.L.l2, 2) && only(R.L.l3, 3) && only(R.L.l4, 4) && only(R.L.l10, 4) && R.L.mode2 === 'multi2' && only(a3, 3) && only(a4, 4) && only(a3u, 3)
    && R.keys['3'].m === 'multi' && R.keys['3'].n === 3 && R.keys['3'].on === 'er-opt-multi' && R.keys['3'].label === '3층' && R.keys['1'].m === 'front' && R.keys['0'].m === 'all' && R.keys['b'].m === 'big' && R.keys['5'].m === 'multi' && R.keys['5'].n === 5 && R.keys['3'].svg && R.keys['3'].gone === 3 && R.keys['1'].gone === 1 && R.keys['0'].gone === 5 && R.keys['b'].gone === 0;
  // ---- K. 측정 시작하면 지우개가 꺼지는가
  await p.keyboard.press('m'); await sleep(100); R.k = await p.evaluate(() => ({ eraser: window.__state.eraser, task: !!window.__state.task, left: window.__app.controls.mouseButtons.LEFT }));
  console.log('K 측정 시작 → 지우개', R.k.eraser, '| 왼쪽 버튼 회전 복귀', R.k.left === 0, '| errors:', errs.length ? errs : 'none');
  const ok = R.bar1400.right <= R.bar1400.win && R.bar1280.right <= R.bar1280.win && R.on.panel && R.on.left === -1 && R.front.count > 20 && !(c1[0] > 200 && c1[1] > 200 && c1[2] < 100) && R.undo.count === 0 && (c2[0] > 200 && c2[1] > 200) && R.redo.count === R.front.count
    && R.restored === 0 && R.lay.count === 6 && R.lay.last6 === 6 && R.lay2.count > 6 && R.marks.two === 0 && R.marks.undo - R.undoBeforeE === 2 && R.lay2u.count === 6 && !R.mid.eraser && R.mid.count === 6 && R.mid.two === 0 && !R.mid.down && R.mid.afterUndo === 0 && R.all.count > 6 && R.all.last6 === 6 && R.big.count === 6 && R.big.last6 === 6 && R.save.exact && R.save.n === R.save.expect && R.save.sizeOk && R.save.unitsKept && R.save.noted && R.save.first1000Same && R.save.bigLeft === 0 && R.reopen.count === R.save.n && R.reopen.unit && !R.reopen.er
    && R.bigc.allKeptRowsBitExact && R.bigc.firstX > 285000 && R.bigc.erased > 0 && R.cloud.hiddenSamples === R.cloud.erased * R.cloud.K && (R.cloud.pickDist == null || R.cloud.pickDist > 0.05) && R.fb.got === R.fb.want && R.fb.markerLeft === 0 && R.Lok && !R.k.eraser && R.k.task && !errs.length;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
