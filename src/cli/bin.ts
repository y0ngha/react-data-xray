#!/usr/bin/env node
// `rdx` 명령의 실행 파일. 라이브러리(index.ts)에서 import 하지 않는다. 최상위에서 main 을 부르므로 package.json 의 sideEffects 에 있다.
import { main } from './main.js';

void main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  cwd: process.cwd(),
  env: process.env,
}).then((code) => {
  process.exitCode = code;
});
