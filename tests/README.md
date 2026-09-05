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
