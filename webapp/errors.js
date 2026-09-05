// 오류·경고 카탈로그 — 앱(app.js)과 도움말(help.html)이 같은 정의를 사용한다.
// level: 'block' = 진행 불가, 'warn' = 계속 가능하지만 결과에 제한, 'info' = 안내
export const ERRORS = {
  E01: {
    level: 'block', title: 'WebGL2를 사용할 수 없습니다',
    why: '이 브라우저 또는 그래픽 설정에서 WebGL2가 꺼져 있어 3D 사진(3DGS)을 그릴 수 없습니다.',
    fix: '최신 Chrome/Edge/Firefox로 열고, 브라우저 설정에서 하드웨어 가속을 켜세요. 원격 데스크톱·가상머신에서는 지원되지 않을 수 있습니다.',
  },
  E02: {
    level: 'block', title: '지원하지 않는 파일 형식입니다',
    why: '이 앱은 3D Gaussian Splatting 파일만 읽습니다. 확장자와 내용이 지원 목록에 없습니다.',
    fix: '지원 형식: .ply (3DGS 원본·SuperSplat 압축 PLY), .spz, .splat, .ksplat, .sog/.zip(SOG). 일반 사진·동영상·메시(.obj/.glb)는 열 수 없습니다.',
  },
  E03: {
    level: 'block', title: '3DGS 파일이 아닌 일반 점군(PLY)입니다',
    why: 'PLY 헤더에 가우시안 속성(opacity, scale_0~2, rot_0~3)이 없습니다. 3DGS 학습 폴더의 input.ply 나 COLMAP의 points3D.ply 같은 일반 점군은 렌더링·측정이 불가능합니다.',
    fix: '학습 결과 폴더의 point_cloud/iteration_30000/point_cloud.ply 를 선택하세요.',
  },
  E04: {
    level: 'block', title: '2DGS 형식 PLY입니다 (scale_2 없음)',
    why: '2D Gaussian Splatting 결과는 크기 값이 2개(scale_0, scale_1)만 있어 3DGS 렌더러가 읽지 못합니다.',
    fix: 'convert_2dgs_to_3dgs_ply.py 로 만든 point_cloud_3dgs.ply (얇은 scale_2 추가본)를 사용하세요.',
  },
  E05: {
    level: 'warn', title: '축척(1 단위 = 몇 m) 정보가 없습니다 → 미터 표시 불가',
    why: '이 파일에는 단위 정보가 없습니다. COLMAP 기반 3DGS는 크기가 임의 단위여서, 앱이 재는 거리는 "모델 단위"이며 실제 미터가 아닙니다. 없는 정보를 앱이 만들어 낼 수는 없습니다.',
    fix: '다음 중 하나로 축척을 알려 주세요. ① [축척 보정]: 실제 길이를 아는 구간(A4 긴 변 297 mm, 줌자로 잰 문 폭 등)의 양 끝을 같은 방법으로 재고 참값을 입력. ② [축척 직접 입력]: 1 단위가 몇 m인지 아는 경우. ③ 파일 옆에 사이드카 JSON({"units":"m"} 또는 {"scale_to_meters":4.2015})을 함께 놓기. 그때까지 거리는 "모델 단위(u)"로 표시됩니다.',
  },
  E06: {
    level: 'info', title: '위(上) 방향 정보가 없어 기본값을 가정했습니다',
    why: '파일에 어느 축이 하늘 방향인지 기록되어 있지 않습니다. 측정 정확도에는 영향이 없고, 화면을 돌릴 때의 편의에만 영향을 줍니다.',
    fix: '화면이 뒤집혀 보이면 상단의 [위 방향] 메뉴에서 +Y/−Y/+Z/−Z 를 바꿔 보세요. COLMAP 기반 PLY는 보통 −Y, SPZ는 +Y 입니다.',
  },
  E07: {
    level: 'block', title: '광선이 2개 미만입니다 → 점을 계산할 수 없습니다',
    why: '한 방향에서 한 번 클릭한 것은 "그 방향 어딘가"라는 정보일 뿐, 거리(깊이)를 정할 수 없습니다. 최소 2개, 권장 5개의 서로 다른 방향 클릭이 필요합니다.',
    fix: '카메라를 돌린 뒤(20° 이상) 같은 점을 다시 클릭하세요. 안내선(노란 선) 위에서 그 점을 찾으면 됩니다.',
  },
  E08: {
    level: 'block', title: '클릭 방향들이 거의 평행합니다 (각도 부족) → 깊이를 정할 수 없습니다',
    why: '광선 사이 최대 각도가 너무 작으면 교점이 앞뒤로 크게 흔들려 결과를 신뢰할 수 없습니다. 카메라를 거의 움직이지 않고 여러 번 클릭한 경우입니다.',
    fix: '마지막 광선을 취소하고, [자동 회전] 또는 왼쪽 드래그로 카메라를 20° 이상 돌린 뒤 다시 클릭하세요. 위·옆·반대쪽에서 골고루 찍을수록 좋습니다.',
  },
  E09: {
    level: 'warn', title: '광선들이 한 점에서 만나지 않습니다 (잔차 과대)',
    why: '클릭 중 하나 이상이 다른 지점을 찍었을 가능성이 큽니다. 계산은 되지만 σ(불확도)가 큽니다.',
    fix: '[최악 광선 제거]로 가장 어긋난 클릭을 지우고 그 각도에서 다시 클릭하거나, 점을 취소하고 더 확대해서 다시 재세요.',
  },
  E10: {
    level: 'block', title: '축척 보정을 계산할 수 없습니다',
    why: '두 점 사이 측정 거리가 0이거나, 입력한 참값이 숫자가 아니거나 0 이하입니다.',
    fix: '서로 다른 두 점을 재고, 참값을 양수로(단위 선택 확인) 입력하세요.',
  },
  E11: {
    level: 'block', title: '파일을 읽는 중 오류가 났습니다 (메모리 부족 또는 손상)',
    why: '브라우저가 파일을 해석하지 못했습니다. 매우 큰 파일(수백 MB 이상)은 브라우저 메모리를 넘을 수 있고, 다운로드 중 잘린 파일은 헤더와 내용이 맞지 않습니다.',
    fix: '다른 탭을 닫고 다시 시도하거나, 가우시안 수를 줄인 파일(예: 3dgs-ply-3dtiles-converter simplify --target-count 1000000, 또는 SuperSplat에서 export)을 사용하세요.',
  },
  E12: {
    level: 'warn', title: '함께 놓은 JSON을 축척 정보로 해석할 수 없습니다',
    why: 'JSON에 인식 가능한 키가 없습니다. 인식 키: "units":"m" / "scale_to_meters": 숫자 / gs_ply_georef.py 가 만든 메타(ply_axes에 meters 포함).',
    fix: '{"units":"m"} 처럼 고쳐서 다시 놓거나, [축척 직접 입력]을 사용하세요.',
  },
  E13: {
    level: 'warn', title: '파일이 매우 큽니다 (가우시안 300만 개 또는 700 MB 초과)',
    why: '브라우저는 파일 전체를 메모리에 올린 뒤 GPU로 보냅니다. 1 GB가 넘는 PLY는 읽는 데 수 분이 걸리거나 메모리 부족으로 실패할 수 있습니다.',
    fix: '가우시안 수를 100만~150만 개로 줄인 파일을 사용하세요. 예: 3dgs-ply-3dtiles-converter simplify --target-count 1500000 --sh 0 입력.ply 출력.ply (또는 SuperSplat에서 export). 측정 정확도는 가늘고 날카로운 구조가 보이는 한 유지됩니다.',
  },
};

export const QUALITY = {
  good: { label: '좋음', desc: '광선 잔차 RMS ≤ 1.5 px, 각도 ≥ 20°' },
  fair: { label: '보통', desc: '잔차 ≤ 4 px 또는 각도 10~20°' },
  poor: { label: '나쁨', desc: '잔차 > 4 px 또는 각도 < 10°' },
};
