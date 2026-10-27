#!/usr/bin/env node
// 빌드한 dist 를 이 패키지를 file: 로 쓰는 앱의 node_modules 에 반영한다.
// 같은 버전으로 덮어쓰면 Vite 의 사전 번들 캐시와 브라우저 캐시가 이전 코드를 계속 쓰므로 Vite 캐시 파일도 지운다.
// 사용법: pnpm sync <앱 디렉터리>   예) pnpm sync ../my-app
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
// exports(react-data-xray/vite 등)가 바뀌어도 앱이 찾을 수 있게 package.json 도 맞춘다.
cpSync('package.json', join(realpathSync(linked), 'package.json'));
const viteCache = join(resolve(appDir), '.vite', 'deps');
for (const file of ['react-data-xray.js', 'react-data-xray.js.map']) rmSync(join(viteCache, file), { force: true });
console.log(`dist → ${target}`);
console.log('앱 vite.config 에 optimizeDeps.exclude 와 server.watch 예외를 두었다면 페이지가 스스로 다시 열립니다(README 의 개발 항목).');
console.log('그렇지 않다면 dev 서버를 --force 로 다시 띄우고, DevTools 의 Disable cache 를 켠 채 새로고침하세요.');
