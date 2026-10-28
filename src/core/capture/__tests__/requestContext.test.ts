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

  describe('스택 상한', () => {
    const original = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
    const restore = () => {
      if (original) Object.defineProperty(Error, 'stackTraceLimit', original);
      else delete (Error as { stackTraceLimit?: number }).stackTraceLimit;
    };

    it('이미 넉넉한 상한(Safari 100, 앱이 올려 둔 값)은 낮추지 않는다', async () => {
      Error.stackTraceLimit = 100;
      const seen: number[] = [];
      const spy = vi.spyOn(Error, 'stackTraceLimit', 'set').mockImplementation((v) => void seen.push(v));
      try {
        await fetch('/api/limit-high');
        expect(seen).toEqual([]);
      } finally {
        spy.mockRestore();
        restore();
      }
    });

    it('상한이 없는 엔진(Firefox)에는 stackTraceLimit 를 새로 만들지 않는다', async () => {
      delete (Error as { stackTraceLimit?: number }).stackTraceLimit;
      try {
        await fetch('/api/limit-none');
        expect(Object.prototype.hasOwnProperty.call(Error, 'stackTraceLimit')).toBe(false);
      } finally {
        restore();
      }
    });

    it('상한을 바꿀 수 없게 얼린 Error(SES)여도 요청은 기록한다', async () => {
      Object.defineProperty(Error, 'stackTraceLimit', { value: 10, writable: false, configurable: true });
      try {
        await fetch('/api/limit-frozen');
        flushQueue();
        expect(getRecords().at(-1)?.url).toBe('/api/limit-frozen');
      } finally {
        restore();
      }
    });
  });

  it('whenSourcesResolved 는 맵을 받은 뒤에야 큐에 오르는 해석 step 도 직접 돌려 끝낸다', async () => {
    // 배경 구동(유휴 콜백과 50ms 보험 타이머)을 막는다. 그래도 끝나면 whenSourcesResolved 가 직접 돌린 것이다.
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn(() => 1),
    );
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number) => (ms === 50 ? 0 : realSetTimeout(fn, ms))) as unknown as typeof setTimeout);
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
      await whenSourcesResolved();
      expect(getRecords()[0].sourceStack).toBe('at load (src/ctx-async.ts:10:3)');
    } finally {
      Error.prepareStackTrace = prepare;
      timers.mockRestore();
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
