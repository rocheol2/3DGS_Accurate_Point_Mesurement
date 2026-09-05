#!/usr/bin/env bash
# 3DGS 다시점 거리 측정기(웹앱)를 로컬 서버로 띄우고 브라우저를 엽니다.
#   사용: tools/start_webapp.sh [포트]   (기본 8000)   종료: Ctrl+C
# index.html 을 더블클릭(file://)하면 브라우저가 스크립트를 차단하므로 이 스크립트나
# webapp/dist/3DGS_거리측정기_단일파일.html(더블클릭용)을 사용하세요.
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")/../webapp"
URL="http://localhost:${PORT}/"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
sleep 1
if command -v google-chrome >/dev/null; then google-chrome "$URL" >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 &
else echo "브라우저에서 $URL 을 여세요."; fi
echo "웹앱 실행 중: $URL   (이 창을 닫거나 Ctrl+C 를 누르면 종료됩니다)"
wait $SERVER_PID
