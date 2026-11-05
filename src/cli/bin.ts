#!/usr/bin/env node
// `rdx` 명령의 실행 파일. 라이브러리(index.ts)에서 import 하지 않는다. 최상위에서 main 을 부르므로 package.json 의 sideEffects 에 있다.
import { main } from './main.js';

// Ctrl+C 면 기다리던 명령을 dev 서버에서 거두고 끝낸다(아직 받아 가지 않았으면 실행하지 않는다). 두 번째 Ctrl+C 는 바로 끝낸다.
const abort = new AbortController();
process.once('SIGINT', () => {
  abort.abort();
  process.once('SIGINT', () => process.exit(130));
});

void main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  cwd: process.cwd(),
  env: process.env,
  signal: abort.signal,
}).then((code) => {
  process.exitCode = code;
});
