#!/bin/sh
# Tailwind CSS 미리 만들기 — static/index.html·app.js에 새 Tailwind 클래스를 쓰면 실행 후 static/tailwind.css를 함께 커밋
# (CDN 버전과 같은 3.4.17 고정)
set -e
cd "$(dirname "$0")/.."
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/obsibook-tw-in.css
npx -y tailwindcss@3.4.17 -c tailwind.config.js -i /tmp/obsibook-tw-in.css -o static/tailwind.css --minify
