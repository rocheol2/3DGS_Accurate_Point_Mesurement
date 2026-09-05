#!/usr/bin/env bash
# 새 PC 에서 이 저장소를 클론한 뒤 한 번 실행: 서브모듈 + 패치 + Node 22 + npm install
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/4] 논문 도구 서브모듈 받기"
git submodule update --init --recursive

echo "[2/4] Site_Research_01 모델 등록 패치 적용 (이미 적용돼 있으면 건너뜀)"
if ! grep -q "Site_Research_01" 3dgs_measurement_tool/src/pages/Home.jsx; then
  git -C 3dgs_measurement_tool apply ../patches/0001-register-Site_Research_01-model.patch
fi

echo "[3/4] Node.js 22 conda 환경 (cesium_measure)"
source ~/miniconda3/etc/profile.d/conda.sh
if ! conda env list | grep -q "^cesium_measure "; then
  conda create -y -n cesium_measure -c conda-forge "nodejs>=22,<23"
fi
conda activate cesium_measure

echo "[4/4] npm install"
(cd 3dgs_measurement_tool && npm install)

cat <<MSG

완료. 다음 단계:
  1) 튜토리얼 2~3단계로 PLY → 3D Tiles 변환 (public/models/site01/ 생성)
     python3 tools/gs_ply_georef.py from-gps ...   # 또는 apply
     npx --yes 3dgs-ply-3dtiles-converter@0.6.5 data/site01/site01_enu.ply 3dgs_measurement_tool/public/models/site01 --coordinate "[35.17779716,128.14690829,5.9]" --no-open-inspector --memory-budget 16
  2) tools/start_tool.sh  → http://localhost:5173
MSG
