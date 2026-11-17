#!/bin/sh
# Tailwind CSS 미리 만들기 — static/index.html·app.js에 새 Tailwind 클래스를 쓰면 실행 후 static/tailwind.css를 함께 커밋
# (CDN 버전과 같은 3.4.17 고정)
set -e
cd "$(dirname "$0")/.."
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/obsibook-tw-in.css
npx -y tailwindcss@3.4.17 -c tailwind.config.js -i /tmp/obsibook-tw-in.css -o static/tailwind.css --minify
# space-y·space-x·divide 규칙의 "앞 형제와 비교(~)" 선택자를 "첫 항목 빼고"로 바꿈 —
# 항목이 수천 개인 목록(목차 등)에서 비교가 n²로 늘어 스타일 계산에 20초+ 걸렸음(2026-11-17)
sed -i 's/>:not(\[hidden\])~:not(\[hidden\])/>:not([hidden]):not(:first-child)/g' static/tailwind.css
