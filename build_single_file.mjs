// 단일 파일 버전 빌드: 모든 JS(three, Spark, app)와 CSS 를 하나의 HTML 에 내장 → 더블클릭(file://)으로 열어도 동작.
// 실행: node build_single_file.mjs   (webapp 폴더에서, Node 18+)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { ERRORS } from './errors.js';
mkdirSync('dist', { recursive: true });
// 1) esbuild 번들 (IIFE). bare import 는 vendor 로 alias
execSync([
  'npx --yes esbuild@0.24.2 app.js --bundle --format=iife --target=es2020 --legal-comments=none',
  '--alias:three=./vendor/three.module.js',
  '--alias:three/addons/controls/OrbitControls.js=./vendor/OrbitControls.js',
  '--alias:three/addons/postprocessing/Pass.js=./vendor/Pass.js',
  '--alias:@sparkjsdev/spark=./vendor/spark.module.js',
  '--outfile=dist/app.bundle.js',
].join(' '), { stdio: 'inherit' });
const bundle = readFileSync('dist/app.bundle.js', 'utf8');
const css = readFileSync('style.css', 'utf8');
let html = readFileSync('index.html', 'utf8');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/m, '');
html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${css}\n</style>`); // 함수 치환: 치환문자열의 $$ 해석 방지
html = html.replace(/<script>\s*\/\/ index\.html 을 더블클릭[\s\S]*?<\/script>\s*/m, ''); // file:// 안내는 단일 파일에선 불필요
html = html.replace('<script type="module" src="app.js"></script>', () => `<script>\n${bundle.replace(/<\/script>/g, () => '<\\/script>')}\n</script>`);
html = html.replace('<title>3DGS 다시점 거리 측정기</title>', '<title>3DGS 다시점 거리 측정기 (단일 파일)</title>');
html = html.replace('<a href="help.html" target="_blank">전체 사용법 열기</a>', '<a href="help.html" target="_blank">전체 사용법 열기</a> · 단일 파일 버전 (더블클릭으로 열림)');
writeFileSync('dist/3DGS_거리측정기_단일파일.html', html);
// 2) help.html 의 모듈 스크립트(오류 표)를 정적 HTML 로 굽기 → file:// 에서도 표가 보임
let help = readFileSync('help.html', 'utf8');
const rows = Object.entries(ERRORS).map(([code, e]) => `<tr><td><code>${code}</code></td><td><span class="tag ${e.level}">${{ block: '진행 불가', warn: '주의', info: '안내' }[e.level]}</span></td><td><b>${e.title}</b><br><span style="color:#94a3b8">${e.why}</span></td><td>${e.fix}</td></tr>`).join('\n');
help = help.replace(/<table id="err-table">[\s\S]*?<\/table>/m, () => `<table id="err-table"><tr><th>코드</th><th>수준</th><th>메시지 / 왜 안 되나</th><th>해결</th></tr>\n${rows}\n</table>`);
help = help.replace(/<script type="module">[\s\S]*?<\/script>\s*/m, '');
writeFileSync('help.html', help);
copyFileSync('help.html', 'dist/help.html');
const size = (readFileSync('dist/3DGS_거리측정기_단일파일.html').length / 1e6).toFixed(1);
console.log(`built dist/3DGS_거리측정기_단일파일.html (${size} MB), dist/help.html, help.html(static table)`);
