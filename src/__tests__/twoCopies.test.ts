import { expect, it, vi } from 'vitest';

it('two_copies: 두 번째로 평가된 rdx 사본은 설치를 건너뛰고 한 번만 경고한다 (#79)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await import('../index.js');
  const wrapped = window.fetch;
  const api = window.__RDX__;
  // 마커가 없으면 resetModules 뒤의 새 install.js 가 fetch 를 한 겹 더 감싼다.
  expect(api).toBeTruthy();
  expect(warn).not.toHaveBeenCalled();

  // 다른 경로로 풀린 사본: 모듈 상태(설치 가드)가 따로인 새 평가
  vi.resetModules();
  await import('../index.js');
  expect(window.fetch).toBe(wrapped); // 두 겹으로 감싸지 않는다
  expect(window.__RDX__).toBe(api);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toMatch(/Two copies of react-data-xray/);

  // 세 번째 사본도 설치하지 않고, 경고는 더 하지 않는다.
  vi.resetModules();
  await import('../index.js');
  expect(window.fetch).toBe(wrapped);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
