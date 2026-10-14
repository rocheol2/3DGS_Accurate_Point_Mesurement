# 웹앱 자동 테스트 (헤드리스 Chrome)

```bash
# 1) 앱을 정적 서버로 띄움 (저장소 루트에서)
cd webapp && python3 -m http.server 8765 --bind 127.0.0.1 &
# 2) 테스트 폴더에서 puppeteer-core 설치 (Node 18+; 이 저장소는 conda env cesium_measure 사용)
cd tests && npm init -y >/dev/null && npm i puppeteer-core
# 3) 합성 정육면체(모서리 2.000 m) PLY 생성
python3 gen_test_ply.py          # cube.ply(축척 정보 없음), cube_m.ply(units: meters)
# 4) 실행 (Chrome 경로: /usr/bin/google-chrome 가정)
node test_app.js                 # 5시점 클릭 측정 정확도, 거리, E05/E08 메시지 → PASS/FAIL
node test_sample.js              # 실제 샘플 로드·렌더·확대창 스크린샷
node test_help.js                # help.html 오류표 행 수
```
스크린샷은 `tests/shots/` 에 저장됩니다. 2026-09-05 결과: 3D 오차 2.5~3.6 mm, 거리 2.0019 ± 0.0036 m, 콘솔 오류 없음.

## 지우개 (2026-10-14)

```bash
python3 gen_test_ply.py && python3 gen_eraser_scenes.py   # cube_floaters.ply(큰 잡티 6개), cube_big.ply(큰 좌표), layers.ply(불투명 평면 4겹)
APP_URL="file://$PWD/../dist/3DGS_거리측정기_단일파일_지우개_되돌리기.html#notour" node test_eraser.js
APP_URL="file://$PWD/../dist/3DGS_거리측정기_단일파일_지우개_되돌리기.html#notour" node test_eraser_undo.js
```
`test_eraser.js` 가 확인하는 것: 도구막대 폭(1400/1280 px) · 지우기/되돌리기/다시/전체 복원 · 깊이 방식(보이는 층만 = 잡티 6개만, 전부 = 뒤까지, 큰 가우시안만 = 잡티 6개만) · 같은 자리 두 번째 붓질이 뒤 층을 지우는지 · 붓질 도중 Esc · **층 수 선택**(평면 4겹에서 1·2·3·4·10층이 정확히 그 겹까지만, 화면 중앙에서 벗어난 자리 포함) · 숫자 키(1/2~9/0/B)·설명 그림 · 원본 그대로 저장(행 수·크기·헤더 주석·앞 1000행 동일·다시 열기) · 큰 좌표 저장(남은 행 전부 비트 단위 동일) · 점군 보기 반영·직접 선택 제외 · 변환 저장(SH0) 다시 열기 · 측정 시작 시 지우개 종료.

`test_eraser_undo.js` (되돌리기·다시 실행, 16항목): 버튼 단계 수 표시 · [↶ 되돌리기] 버튼 · Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z · 전체 복원도 기록되고 Ctrl+Z 로 취소 · 작업 기록 줄 클릭으로 처음 상태·중간 단계로 이동 · 기록 클릭 뒤 화면 밀림 없음 · 되돌린 뒤 새 붓질이면 다시 실행 기록 정리 · 알림이 쌓여 3D 화면을 가리지 않음 · 저장 시점 추적(저장됨 ↔ 저장 안 됨) · 붓질 도중 Ctrl+Z · 지우개를 끈 뒤 Ctrl+Z·기록 줄 버튼 · 측정 중에는 지우개 기록 불변 · 콘솔 오류 없음.
