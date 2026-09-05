// 첫 방문 기능 소개 투어 — 화면 요소를 스포트라이트로 비추며 단계별 설명을 보여준다.
const ILLUS_RAYS = `
<svg viewBox="0 0 360 150" width="100%" height="140" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="ar" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#fbbf24"/></marker></defs>
  <rect x="0" y="0" width="360" height="150" fill="#0b1020"/>
  <!-- 대상 점 -->
  <circle cx="180" cy="95" r="5" fill="#22d3ee"/>
  <text x="190" y="90" fill="#22d3ee" font-size="11">잴 점</text>
  <!-- 카메라들 -->
  <g fill="#e6ecf8" font-size="10">
    <rect x="30" y="20" width="22" height="14" rx="2" fill="#3b82f6"/><text x="26" y="48">시점 1</text>
    <rect x="120" y="8" width="22" height="14" rx="2" fill="#3b82f6"/><text x="116" y="36">시점 2</text>
    <rect x="230" y="10" width="22" height="14" rx="2" fill="#3b82f6"/><text x="226" y="38">시점 3</text>
    <rect x="310" y="40" width="22" height="14" rx="2" fill="#3b82f6"/><text x="300" y="68">시점 4</text>
    <rect x="300" y="120" width="22" height="14" rx="2" fill="#3b82f6"/><text x="270" y="134">시점 5</text>
  </g>
  <g stroke="#fbbf24" stroke-width="1.5" marker-end="url(#ar)">
    <line x1="41" y1="34" x2="176" y2="92"/><line x1="131" y1="22" x2="179" y2="90"/><line x1="241" y1="24" x2="182" y2="90"/>
    <line x1="321" y1="54" x2="185" y2="94"/><line x1="311" y1="120" x2="185" y2="97"/>
  </g>
  <text x="14" y="140" fill="#94a3b8" font-size="11">5개 광선이 만나는 곳 = 측정된 3D 점 (최소제곱)</text>
</svg>`;

const ILLUS_GUIDE = `
<svg viewBox="0 0 360 150" width="100%" height="140" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="360" height="150" fill="#0b1020"/>
  <rect x="20" y="15" width="200" height="120" fill="#182238" stroke="#26314d"/>
  <text x="26" y="30" fill="#94a3b8" font-size="10">시점 2에서 본 화면</text>
  <line x1="30" y1="120" x2="210" y2="40" stroke="#fbbf24" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="120" y="118" fill="#fbbf24" font-size="10">안내선 = 1번 클릭의 광선</text>
  <circle cx="130" cy="76" r="6" fill="none" stroke="#22d3ee" stroke-width="2"/>
  <text x="140" y="70" fill="#22d3ee" font-size="10">여기서 같은 점 클릭</text>
  <circle cx="290" cy="75" r="48" fill="#000" stroke="#fbbf24" stroke-width="2"/>
  <line x1="290" y1="35" x2="290" y2="115" stroke="#22d3ee" stroke-width="1"/><line x1="250" y1="75" x2="330" y2="75" stroke="#22d3ee" stroke-width="1"/>
  <text x="262" y="138" fill="#94a3b8" font-size="10">확대창(4×)</text>
</svg>`;

export const TOUR_STEPS = [
  { target: null, title: '3DGS 다시점 거리 측정기에 오신 것을 환영합니다',
    body: '3D 사진(3DGS) 속 두 점 사이가 실제로 몇 미터인지 재는 도구입니다. 설치·변환 없이 브라우저에서 파일을 열면 바로 시작됩니다. 6단계로 기능을 소개합니다. (약 1분)',
    illus: ILLUS_RAYS },
  { target: '#btn-open', title: '① 파일 열기',
    body: '.ply / .spz / .splat / .ksplat / .sog 파일을 선택하거나 화면에 끌어다 놓습니다. 파일은 컴퓨터 밖으로 전송되지 않습니다. 축척 정보가 담긴 JSON을 같이 놓으면 자동으로 읽습니다.' },
  { target: '#btn-point', title: '② 점 측정 — 같은 점을 여러 각도에서',
    body: '잴 점을 크게 확대해 클릭하면 노란 광선이 생깁니다. 카메라를 20° 이상 돌려 같은 점을 다시 클릭, 이걸 5번 반복하면 광선들이 만나는 3D 점이 자동 계산됩니다. 한 곳에서 한 번 클릭하는 것으로는 깊이를 알 수 없기 때문입니다.',
    illus: ILLUS_RAYS },
  { target: '#coach', title: '③ 안내선과 확대창',
    body: '두 번째 클릭부터는 첫 광선이 노란 안내선으로 그려집니다. 그 선 위에서 같은 점을 찾으면 됩니다. 커서 옆 확대창이 픽셀 단위로 조준을 돕고, 자동 정밀 보정이 클릭을 첫 클릭과 같은 무늬 위치로 살짝 옮겨 줍니다. 아래 코치 바가 지금 할 일을 알려 줍니다.',
    illus: ILLUS_GUIDE },
  { target: '#btn-dist', title: '④ 거리 측정',
    body: '점 A, 점 B를 차례로 재면 화면에 거리와 ± 오차가 표시됩니다. 결과 탭에서 두 점을 체크해 거리를 구할 수도 있습니다.' },
  { target: '#btn-scale', title: '⑤ 축척 — 없으면 없다고 알려 드립니다',
    body: '파일에 "1 단위 = 몇 m" 정보가 없으면 거리는 모델 단위(u)로만 표시되고, 상단 배너가 이유와 해결 방법을 알려 줍니다. A4 용지나 줌자로 잰 길이 하나로 [축척 보정]을 하면 이후 모든 거리가 미터로 바뀝니다.' },
  { target: '#btn-check', title: '⑥ 정보 점검 · 내보내기',
    body: '[정보 점검]은 파일 형식·축척·광선 수·각도 등 측정에 필요한 정보가 충분한지 표로 보여 줍니다. [내보내기]로 CSV / JSON / PNG를 저장합니다. 준비되셨으면 파일을 열어 보세요!' },
];

export function startTour(steps = TOUR_STEPS, { onDone } = {}) {
  const root = document.getElementById('tour-root');
  root.innerHTML = '';
  let i = 0;
  const mask = document.createElement('div'); mask.className = 'tour-mask';
  const hole = document.createElement('div'); hole.className = 'tour-hole';
  const card = document.createElement('div'); card.className = 'tour-card';
  root.append(mask, hole, card);

  function place() {
    const s = steps[i];
    const t = s.target ? document.querySelector(s.target) : null;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (t) {
      const r = t.getBoundingClientRect();
      const pad = 6;
      Object.assign(hole.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + 2 * pad) + 'px', height: (r.height + 2 * pad) + 'px', display: 'block' });
      // 카드 위치: 대상 아래 우선, 공간 없으면 위
      card.style.visibility = 'hidden'; card.style.display = 'block';
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let left = Math.min(Math.max(8, r.left), vw - cw - 8);
      let top = r.bottom + 14;
      if (top + ch > vh - 8) top = Math.max(8, r.top - ch - 14);
      Object.assign(card.style, { left: left + 'px', top: top + 'px', visibility: 'visible' });
    } else {
      hole.style.display = 'none';
      card.style.visibility = 'hidden'; card.style.display = 'block';
      Object.assign(card.style, { left: Math.max(8, (vw - card.offsetWidth) / 2) + 'px', top: Math.max(8, (vh - card.offsetHeight) / 2) + 'px', visibility: 'visible' });
    }
  }
  function render() {
    const s = steps[i];
    card.innerHTML = `<h3>${s.title}</h3><div>${s.body}</div>${s.illus ? `<div class="illus">${s.illus}</div>` : ''}
      <div class="nav"><span class="muted">${i + 1} / ${steps.length}</span><span>
        <button class="btn small ghost" data-act="skip">건너뛰기</button>
        ${i > 0 ? '<button class="btn small" data-act="prev">이전</button>' : ''}
        <button class="btn small primary" data-act="next">${i === steps.length - 1 ? '시작하기' : '다음'}</button></span></div>`;
    place();
  }
  function end() { root.innerHTML = ''; window.removeEventListener('resize', place); document.removeEventListener('keydown', onKey); onDone && onDone(); }
  function onKey(e) { if (e.key === 'Escape') end(); else if (e.key === 'ArrowRight' || e.key === 'Enter') step(1); else if (e.key === 'ArrowLeft') step(-1); }
  function step(d) { i += d; if (i < 0) i = 0; if (i >= steps.length) return end(); render(); }
  card.addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (!a) return; const act = a.dataset.act; if (act === 'skip') end(); else if (act === 'prev') step(-1); else step(1); });
  mask.addEventListener('click', () => {}); // 바깥 클릭은 무시(실수 방지)
  window.addEventListener('resize', place); document.addEventListener('keydown', onKey);
  render();
  return { end };
}
