#!/usr/bin/env node
// 빌드한 dist 를 이 패키지를 file: 로 쓰는 앱의 node_modules 에 반영한다.
// 같은 버전으로 덮어쓰면 Vite 의 사전 번들 캐시와 브라우저 캐시가 이전 코드를 계속 쓰므로 Vite 캐시 파일도 지운다.
// 사용법: pnpm sync <앱 디렉터리>   예) pnpm sync ~/Projects/whatap-front/.worktrees/rdx/apps/whatap-front
import { cpSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appDir = process.argv[2];
if (!appDir) {
  console.error('사용법: pnpm sync <앱 디렉터리>');
  process.exit(1);
}
const linked = join(resolve(appDir), 'node_modules', 'react-data-xray');
if (!existsSync(linked)) {
  console.error(`${linked} 이 없습니다. 앱에서 먼저 pnpm add -D file:${process.cwd()} 를 실행하세요.`);
  process.exit(1);
}
const target = join(realpathSync(linked), 'dist');
rmSync(target, { recursive: true, force: true });
cpSync('dist', target, { recursive: true });
const viteCache = join(resolve(appDir), '.vite', 'deps');
for (const file of ['react-data-xray.js', 'react-data-xray.js.map']) rmSync(join(viteCache, file), { force: true });
console.log(`dist → ${target}`);
console.log('앱의 dev 서버를 --force 로 다시 띄우고, 브라우저에서 모듈 캐시를 비운 뒤 새로고침하세요.');
