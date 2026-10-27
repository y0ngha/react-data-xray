import { describe, expect, it } from 'vitest';

import { ownFramePattern } from '../requestContext.js';

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
});
