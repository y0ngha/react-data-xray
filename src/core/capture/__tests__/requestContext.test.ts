import { describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../../../testing/fetchMock.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getRecords } from '../../requests/store.js';
import { whenSourcesResolved } from '../requestContext.js';

const inlineMap = (map: object) => `data:application/json;base64,${btoa(JSON.stringify(map))}`;

describe('요청 문맥', () => {
  it('요청을 보낸 코드 위치를 남기되 rdx 가로채기 프레임은 뺀다', async () => {
    await fetch('/api/where');
    flushQueue();
    const { stack } = getRecords()[0];
    expect(stack).toContain('requestContext.test');
    expect(stack).not.toContain('fetchInterceptor');
  });

  it('whenSourcesResolved 는 맵을 받은 뒤에야 큐에 오르는 해석 step 도 직접 돌려 끝낸다', async () => {
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn(() => 1),
    ); // 배경은 50ms 보험 타이머뿐이므로, 그보다 빨리 끝나야 직접 돌린 것이다
    const code = `a\nb\nload()\n//# sourceMappingURL=${inlineMap({ version: 3, sources: ['ctx-async.ts'], mappings: ';;AASE' })}`;
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (input, init) => {
      if (!String(input).includes('/src/ctx-async.ts')) return original(input, init);
      await new Promise((resolve) => setTimeout(resolve, 5)); // 맵은 한참 뒤에 오고, 해석 step 은 그 뒤에야 큐에 오른다
      return new Response(code);
    });
    const prepare = Error.prepareStackTrace;
    Error.prepareStackTrace = () => 'Error\nat load (http://localhost:3000/src/ctx-async.ts:3:5)';
    try {
      await fetch('/api/async-map');
      const start = performance.now();
      await whenSourcesResolved();
      expect(getRecords()[0].sourceStack).toBe('at load (src/ctx-async.ts:10:3)');
      expect(performance.now() - start).toBeLessThan(40);
    } finally {
      Error.prepareStackTrace = prepare;
      vi.unstubAllGlobals();
    }
  });

  it('창 포커스·탭 표시·재연결 직후의 요청에 자동 재요청 표시를 붙인다', async () => {
    window.dispatchEvent(new Event('focus'));
    await fetch('/api/after-focus');
    document.dispatchEvent(new Event('visibilitychange'));
    await fetch('/api/after-visible');
    window.dispatchEvent(new Event('online'));
    await fetch('/api/after-online');
    flushQueue();
    expect(getRecords().map((r) => r.trigger)).toEqual(['focus', 'focus', 'reconnect']);
  });
});
