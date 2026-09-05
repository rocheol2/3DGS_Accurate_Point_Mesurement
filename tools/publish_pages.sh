#!/usr/bin/env bash
# webapp/ 폴더의 최신 내용을 gh-pages 브랜치로 만들어 GitHub Pages 에 재배포합니다.
#   사용: tools/publish_pages.sh      (main 에 커밋된 webapp/ 내용을 배포)
# 배포 주소: https://rocheol2.github.io/3DGS_Accurate_Point_Mesurement/
set -e
cd "$(dirname "$0")/.."
if ! git diff --quiet -- webapp; then echo "webapp/ 에 커밋되지 않은 변경이 있습니다. 먼저 커밋하세요."; exit 1; fi
( cd webapp && source ~/miniconda3/etc/profile.d/conda.sh && conda activate cesium_measure && node build_single_file.mjs ) || echo "(단일 파일 빌드 생략)"
git add webapp/dist webapp/help.html && git diff --cached --quiet || git commit -q -m "webapp: 단일 파일 버전 재빌드" 
git branch -D gh-pages 2>/dev/null || true
git subtree split --prefix webapp -b gh-pages -q
git push -f origin gh-pages
git push origin main
echo "배포 요청 완료. 1~2분 뒤 https://rocheol2.github.io/3DGS_Accurate_Point_Mesurement/ 에서 확인하세요."
