import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('fetch·Response·XHR 이 없는 환경에서도 설치가 깨지지 않고, 없는 것을 대신 만들지 않는다', async () => {
  vi.resetModules();
  vi.stubGlobal('fetch', undefined);
  vi.stubGlobal('Response', undefined);
  vi.stubGlobal('XMLHttpRequest', undefined);
  const { installCapture, getNativeFetch } = await import('../install.js');
  expect(() => installCapture()).not.toThrow();
  expect(window.fetch).toBeUndefined();
  expect(getNativeFetch()).toBeUndefined();
});
