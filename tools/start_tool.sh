#!/usr/bin/env bash
# 3DGS 측정 도구(Vite 개발 서버) 실행: http://localhost:5173
set -e
source ~/miniconda3/etc/profile.d/conda.sh
conda activate cesium_measure
cd ~/storage/Cesium/3dgs_measurement_tool
# 다른 PC(노트북 등)에서 접속하려면 아래 줄 끝에  -- --host 0.0.0.0  을 붙이세요.
exec npm run dev
