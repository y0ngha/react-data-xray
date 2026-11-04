#!/usr/bin/env node
// package.json 의 sideEffects 가 실제 설치 코드와 맞는지 본다(#61). pnpm build 뒤에 돈다.
// 1. dist 의 모든 .js 에서 모듈 최상위에 평가만으로 밖을 바꿀 수 있는 코드(설치 호출, if, 대입, 순수하다고 모르는 호출)가
//    있는 파일을 찾아 sideEffects 목록(과 아래 DROPPABLE)과 같은지 본다.
// 2. `import 'react-data-xray'` 만 있는 진입 파일을 rolldown 으로 묶어, dev 에는 설치 코드가 남고 production 은 비워지는지 본다.
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { join, relative, resolve } from 'node:path';
import { rolldown } from 'rolldown';
import { parseSync } from 'rolldown/experimental';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const { sideEffects } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

// 최상위 코드가 1번 검사에 걸리지만 sideEffects 에 넣지 않는 파일과 그 이유. 넣으면 production 에도 그 코드가 남는다.
// 모듈을 쓰지 않으면 지워져도 되는 것만 둔다(그 모듈을 쓰는 코드가 있어야 의미가 있는 지연 캐시·순수 계산).
const DROPPABLE = {
  './dist/core/capture/requestOrigins.js':
    'HMR 로 다시 평가돼도 같은 map 을 쓰려고 전역에 WeakMap 을 한 번 만들어 둘 뿐이다. 이 모듈을 쓰는 코드가 없으면 필요 없다.',
  './dist/core/capture/requestContext.js': '자기 모듈 URL 을 new Error().stack 에서 읽어 정규식을 만든다. 밖을 바꾸지 않는다.',
};

// 인자만 순수하면 결과도 밖을 바꾸지 않는 호출. React 의 팩토리는 React 자신도 순수로 표시한다.
const PURE_CALLS = new Set([
  'Symbol',
  'Symbol.for',
  'Object.freeze',
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.fromEntries',
  'Promise.resolve',
  'String.raw',
  'createContext',
  'forwardRef',
  'memo',
  'lazy',
]);
// 받는 값이 배열이면 새 배열을 만들 뿐인 메서드. 받는 값의 종류는 모르므로 이름으로만 본다.
const PURE_ARRAY_METHODS = new Set(['map', 'flatMap', 'filter', 'slice', 'concat', 'join']);
const PURE_NEW = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'RegExp']);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);
const EFFECTS = new Set([
  'AssignmentExpression',
  'UpdateExpression',
  'AwaitExpression',
  'YieldExpression',
  'ImportExpression',
  'TaggedTemplateExpression',
]);

const isPureCall = (callee) =>
  PURE_CALLS.has(calleeName(callee)) ||
  (callee.type === 'MemberExpression' && !callee.computed && PURE_ARRAY_METHODS.has(callee.property.name));

const calleeName = (callee) => {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier')
    return `${callee.object.name}.${callee.property.name}`;
  return undefined;
};

/** 식을 평가할 때 밖을 바꿀 수 있는 부분의 설명. 함수 본문은 불릴 때 도므로 들어가지 않는다. */
const effectsIn = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) effectsIn(child, out);
    return out;
  }
  if (typeof node.type !== 'string') return out;
  if (FUNCTIONS.has(node.type)) return out;
  if (node.type === 'ClassExpression' || node.type === 'ClassDeclaration') return effectsIn(node.superClass, out);
  if (EFFECTS.has(node.type)) out.push(node.type);
  else if (node.type === 'UnaryExpression' && node.operator === 'delete') out.push('delete');
  else if (node.type === 'CallExpression' && !isPureCall(node.callee)) out.push(`${calleeName(node.callee) ?? '(식)'}() 호출`);
  else if (node.type === 'NewExpression' && !PURE_NEW.has(calleeName(node.callee))) out.push(`new ${calleeName(node.callee) ?? '(식)'}`);
  for (const [key, value] of Object.entries(node)) if (key !== 'type' && value && typeof value === 'object') effectsIn(value, out);
  return out;
};

/** 최상위 문장 하나가 밖을 바꿀 수 있으면 그 설명을, 아니면 빈 배열을 돌려준다. */
const statementEffects = (node) => {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'FunctionDeclaration':
      return [];
    case 'ExpressionStatement':
      return node.directive ? [] : [`최상위 식(${node.expression.type})`];
    case 'ClassDeclaration':
    case 'VariableDeclaration':
      return effectsIn(node);
    case 'ExportNamedDeclaration':
      return node.declaration ? statementEffects(node.declaration) : [];
    case 'ExportDefaultDeclaration': {
      const { declaration } = node;
      if (['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression', 'Identifier', 'Literal'].includes(declaration.type))
        return [];
      if (declaration.type === 'ClassDeclaration' || declaration.type === 'ClassExpression') return effectsIn(declaration);
      return [`export default ${declaration.type}`];
    }
    default:
      return [`최상위 ${node.type}`];
  }
};

/** 파일의 최상위 부수 효과. 파싱 오류가 있으면 errors 에 담는다. */
const moduleEffects = (file, code) => {
  const { program, errors } = parseSync(file, code);
  return { errors: errors.map((error) => error.message), effects: program.body.flatMap(statementEffects) };
};

// 검사기 자신을 먼저 확인한다. 이 표가 틀리면 1번 검사는 믿을 수 없다.
const SELF_TEST = [
  ['const x = install();', true],
  ['export const x = Object.freeze(install());', true],
  ['const m = globalThis[K] ??= new WeakMap();', true],
  ['let n = 0, m = n++;', true],
  ['export default install();', true],
  ['export default new Thing();', true],
  ['export default (a, b);', true],
  ['class A extends mixin() {}', true],
  ['if (dev) install();', true],
  ["'use client';\n'use strict';", false],
  ["const K = Symbol.for('k'); const m = new Map(); const s = new Set(['a']);", false],
  ['export const f = () => install(); export default function g() { install(); }', false],
  ['export default f;', false],
  ["const D = new Map([...'ab'].map((c, i) => [c, i]));", false],
  ['const C = createContext(null); export const P = memo(function P() { return install(); });', false],
];
for (const [code, expected] of SELF_TEST) {
  const { errors, effects } = moduleEffects('self-test.js', code);
  if (errors.length || effects.length > 0 !== expected)
    failures.push(
      `검사기 자체 확인 실패: ${JSON.stringify(code)} 는 ${expected ? '부수 효과로 잡혀야' : '잡히지 않아야'} 한다(${effects.join(', ') || errors.join(', ') || '없음'}).`,
    );
}

const jsFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });

if (!Array.isArray(sideEffects)) {
  failures.push(`package.json 의 sideEffects 가 배열이 아니다(${JSON.stringify(sideEffects)}). 설치 코드가 있는 파일을 나열해야 한다.`);
} else {
  const found = new Map();
  for (const path of jsFiles(dist)) {
    const file = `./${relative(root, path)}`;
    const { errors, effects } = moduleEffects(path, readFileSync(path, 'utf8'));
    if (errors.length) failures.push(`${file} 를 파싱하지 못했다: ${errors.join('; ')}`);
    if (effects.length) found.set(file, effects);
  }
  for (const [file, effects] of found)
    if (!sideEffects.includes(file) && !(file in DROPPABLE))
      failures.push(`${file} 의 최상위에 부수 효과가 있는데 sideEffects 에 없다: ${[...new Set(effects)].join(', ')}`);
  for (const file of sideEffects)
    if (!found.has(file)) failures.push(`sideEffects 의 ${file} 에 최상위 설치 코드가 없다(파일이 없거나 옮겨졌다).`);
  for (const file of Object.keys(DROPPABLE)) {
    if (!found.has(file)) failures.push(`DROPPABLE 의 ${file} 에 더는 최상위 부수 효과가 없다. 목록에서 뺀다.`);
    if (sideEffects.includes(file)) failures.push(`${file} 이 sideEffects 와 DROPPABLE 에 함께 있다.`);
  }
}

// 1번 결과를 번들 전에 내보낸다. rolldown 이 던져도 가려지지 않게.
const report = () => {
  for (const failure of failures.splice(0)) console.error(`✗ ${failure}`);
};
let failed = failures.length > 0;
report();

// 앱이 node_modules 로 rdx 를 받는 모양을 흉내 낸다. 링크를 따라가면 이 저장소의 package.json 이 적용된다.
// junction 은 심볼릭 링크 권한이 없는 Windows 에서도 만들어진다(다른 OS 에서는 무시된다).
const app = mkdtempSync(join(tmpdir(), 'rdx-side-effects-'));
mkdirSync(join(app, 'node_modules'));
symlinkSync(root, join(app, 'node_modules', 'react-data-xray'), 'junction');
writeFileSync(join(app, 'entry.js'), "import 'react-data-xray';\n");

const bundle = async (mode) => {
  const unresolved = [];
  const build = await rolldown({
    input: join(app, 'entry.js'),
    cwd: app,
    external: [/^react($|\/)/, /^react-dom($|\/)/],
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify(mode) } },
    onLog: (level, log) => {
      if (log.code === 'UNRESOLVED_IMPORT') unresolved.push(stripVTControlCharacters(log.message).split('\n')[0]);
      else if (level === 'warn') console.warn(`(${mode}) rolldown: ${log.message}`);
    },
  });
  const { output } = await build.generate({ format: 'esm', minify: mode === 'production' });
  await build.close();
  const code = output[0].code;
  if (unresolved.length) failures.push(`(${mode}) rolldown 이 import 를 찾지 못했다: ${unresolved.join('; ')}`);
  if (/\b(?:from|import)\s*\(?\s*["']react-data-xray["']/.test(code))
    failures.push(`(${mode}) 번들에 react-data-xray import 가 그대로 남았다. 패키지를 찾지 못했다.`);
  return code;
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
} catch (error) {
  failures.push(`rolldown 으로 묶지 못했다: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(app, { recursive: true, force: true });
}

failed ||= failures.length > 0;
report();
if (failed) process.exit(1);
console.log(`sideEffects 확인: ${sideEffects.join(', ')}`);
