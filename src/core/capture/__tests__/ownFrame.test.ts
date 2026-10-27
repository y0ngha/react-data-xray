import { describe, expect, it } from 'vitest';

import { ownFramePattern, runtimeModuleUrl } from '../requestContext.js';

describe('ownFramePattern', () => {
  it('Vite 사전 번들에서는 rdx 번들 파일만 빼고, 같은 폴더의 다른 라이브러리 프레임은 남긴다', () => {
    const pattern = ownFramePattern('http://localhost:8082/assets/node_modules/.vite/deps/react-data-xray.js?v=aa712148');
    expect(pattern.test('at window.fetch (http://localhost:8082/assets/node_modules/.vite/deps/react-data-xray.js?v=aa712148:120:9)')).toBe(
      true,
    );
    expect(pattern.test('at dispatchRequest (http://localhost:8082/assets/node_modules/.vite/deps/axios.js?v=aa712148:1500:10)')).toBe(
      false,
    );
  });

  it('소스·dist 그대로면 capture 폴더 바로 아래 파일만 빼고, 하위 폴더(테스트 등)는 남긴다', () => {
    const pattern = ownFramePattern('file:///app/node_modules/react-data-xray/dist/core/capture/requestContext.js');
    expect(pattern.test('at fetch (/app/node_modules/react-data-xray/dist/core/capture/fetchInterceptor.js:30:5)')).toBe(true);
    expect(pattern.test('at test (/app/node_modules/react-data-xray/dist/core/capture/__tests__/x.test.js:3:1)')).toBe(false);
    expect(pattern.test('at load (/app/src/api.ts:10:3)')).toBe(false);
  });

  it('import.meta.url 이 스택에 없으면(Turbopack·webpack 청크) 스택의 실제 파일로 rdx 프레임을 뺀다', () => {
    const chunk = 'http://localhost:4200/_next/static/chunks/node_modules_react-data-xray_dist_08-tkcax494c3._.js';
    const stack = `Error\n    at module evaluation (${chunk}:1201:31)\n    at instantiateModule (http://localhost:4200/_next/static/chunks/runtime.js:7:3)`;
    const url = runtimeModuleUrl('file:///app/node_modules/react-data-xray/dist/core/capture/requestContext.js', stack);
    expect(url).toBe(chunk);
    const pattern = ownFramePattern(url);
    expect(pattern.test(`at annotateRequest (${chunk}:278:17)`)).toBe(true);
    expect(pattern.test('at fetchTickerSearch (http://localhost:4200/_next/static/chunks/src_1ubvxa542wr2f._.js:1586:28)')).toBe(false);
  });

  it('import.meta.url 이 스택에 그대로 나오면(Vite·소스) 그 값을 쓴다', () => {
    const declared = 'file:///app/node_modules/react-data-xray/dist/core/capture/requestContext.js';
    const stack = 'Error\n    at /app/node_modules/react-data-xray/dist/core/capture/requestContext.js:26:1';
    expect(runtimeModuleUrl(declared, stack)).toBe(declared);
    expect(runtimeModuleUrl(declared, undefined)).toBe(declared);
  });
});
