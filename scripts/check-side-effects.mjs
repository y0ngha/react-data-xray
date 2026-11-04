#!/usr/bin/env node
// package.json 의 sideEffects 가 실제 설치 코드와 맞는지 본다(#61). pnpm build 뒤에 돈다.
// 1. dist 의 모든 .js 에서 모듈 최상위에 선언이 아닌 문장(설치 호출, if 등)이 있는 파일을 찾아 sideEffects 목록과 같은지 본다.
// 2. `import 'react-data-xray'` 만 있는 진입 파일을 rolldown 으로 묶어, dev 에는 설치 코드가 남고 production 은 비워지는지 본다.
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { parseSync } from 'rolldown/experimental';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const { sideEffects } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

// 최상위에 있어도 평가만으로 밖을 바꾸지 않는 문장. 변수 초기값의 호출(new Map(), 캐시 생성)은 모듈 안에 머문다고 본다.
const DECLARATIONS = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
]);
const isDeclaration = (node) => {
  if (DECLARATIONS.has(node.type)) return true;
  if (node.type === 'ExportNamedDeclaration') return !node.declaration || DECLARATIONS.has(node.declaration.type);
  if (node.type === 'ExportDefaultDeclaration') return node.declaration.type !== 'CallExpression';
  return false;
};

const jsFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });

if (!Array.isArray(sideEffects)) {
  failures.push(`package.json 의 sideEffects 가 배열이 아니다(${JSON.stringify(sideEffects)}). 설치 코드가 있는 파일을 나열해야 한다.`);
} else {
  const found = jsFiles(dist)
    .filter((file) => parseSync(file, readFileSync(file, 'utf8')).program.body.some((node) => !isDeclaration(node)))
    .map((file) => `./${relative(root, file)}`)
    .sort();
  const listed = [...sideEffects].sort();
  for (const file of found) if (!listed.includes(file)) failures.push(`${file} 의 최상위에 설치 코드가 있는데 sideEffects 에 없다.`);
  for (const file of listed)
    if (!found.includes(file)) failures.push(`sideEffects 의 ${file} 에 최상위 설치 코드가 없다(파일이 없거나 옮겨졌다).`);
}

// 앱이 node_modules 로 rdx 를 받는 모양을 흉내 낸다. 링크를 따라가면 이 저장소의 package.json 이 적용된다.
const app = mkdtempSync(join(tmpdir(), 'rdx-side-effects-'));
mkdirSync(join(app, 'node_modules'));
symlinkSync(root, join(app, 'node_modules', 'react-data-xray'), 'dir');
writeFileSync(join(app, 'entry.js'), "import 'react-data-xray';\n");

const bundle = async (mode) => {
  const build = await rolldown({
    input: join(app, 'entry.js'),
    cwd: app,
    external: [/^react($|\/)/, /^react-dom($|\/)/],
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify(mode) } },
    logLevel: 'silent',
  });
  const { output } = await build.generate({ format: 'esm', minify: mode === 'production' });
  await build.close();
  return output[0].code;
};

try {
  const dev = await bundle('development');
  const prod = await bundle('production');
  const devBytes = Buffer.byteLength(dev);
  const prodBytes = Buffer.byteLength(prod);
  console.log(`단독 import 번들: development ${devBytes} bytes, production ${prodBytes} bytes`);
  // 렌더 감시(DevTools 훅)와 AI 보고서 창구가 둘 다 남아야 한다. 요청 가로채기는 그 둘과 같은 진입에서 설치된다.
  for (const marker of ['__REACT_DEVTOOLS_GLOBAL_HOOK__', '__RDX__', 'XMLHttpRequest']) {
    if (!dev.includes(marker)) failures.push(`development 번들에 ${marker} 가 없다. 단독 import 가 번들에서 빠졌다.`);
  }
  // production 은 rdx 코드가 남지 않아야 한다. 빈 번들도 rolldown 의 머리말 몇 바이트는 남는다.
  if (prodBytes > 512) failures.push(`production 번들이 ${prodBytes} bytes 다. rdx 코드가 production 에 남았다.`);
} finally {
  rmSync(app, { recursive: true, force: true });
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(`sideEffects 확인: ${sideEffects.join(', ')}`);
