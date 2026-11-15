// static/tailwind.css 생성용 (scripts/build-css.sh). index.html·app.js에 쓴 클래스만 뽑음 — 새 클래스를 쓰면 다시 생성
module.exports = { content: ['./static/index.html', './static/app.js'], theme: { extend: {} }, plugins: [] };
