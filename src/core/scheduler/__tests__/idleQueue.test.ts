import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
type Q = typeof import('../idleQueue.js');
let enqueue: Q['enqueue'];
let flushQueue: Q['flushQueue'];
let isQueuePending: Q['isQueuePending'];

// 다른 모듈이 공용 큐에 넣은 일과 섞이지 않게, 테스트마다 새 큐를 쓴다.
beforeEach(async () => {
  vi.resetModules();
  ({ enqueue, flushQueue, isQueuePending } = await import('../idleQueue.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('idleQueue', () => {
  it('e.g. 하나 넣고 비운다', () => {
    enqueue(() => true);
    expect(isQueuePending()).toBe(true);
    expect(flushQueue()).toBe(true);
    expect(isQueuePending()).toBe(false);
  });

  it('e.g. 세 번째 step 에서 끝난다', () => {
    let n = 0;
    enqueue(() => ++n === 3);
    expect(flushQueue()).toBe(true);
    expect(n).toBe(3);
  });

  it('e.g. 끝나지 않는 큐는 flushQueue(0) 에 한 step 만 돈다', () => {
    let n = 0;
    let stop = false;
    enqueue(() => (n++, stop));
    expect(flushQueue(0)).toBe(false);
    expect(n).toBe(1);
    stop = true; // afterEach 가 비울 수 있게
  });

  it('runs_in_fifo_order', () => {
    const log: string[] = [];
    let a = 0;
    let b = 0;
    enqueue(() => (log.push('A'), ++a === 2));
    enqueue(() => (log.push('B'), ++b === 2));
    flushQueue();
    expect(log).toEqual(['A', 'A', 'B', 'B']);
  });

  it('reentrant_flush_is_noop', () => {
    let inner: boolean | undefined;
    let after = false;
    enqueue(() => ((inner = flushQueue()), true));
    enqueue(() => ((after = true), true));
    expect(flushQueue()).toBe(true);
    expect(inner).toBe(false);
    expect(after).toBe(true);
  });

  it('step_throw_drops_step', () => {
    let ran = false;
    enqueue(() => {
      throw new Error('x');
    });
    enqueue(() => ((ran = true), true));
    expect(() => flushQueue()).not.toThrow();
    expect(ran).toBe(true);
    expect(isQueuePending()).toBe(false);
  });

  it('background_drains', () => {
    vi.useFakeTimers();
    let n = 0;
    enqueue(() => ++n === 3);
    vi.runAllTimers();
    expect(n).toBe(3);
    expect(isQueuePending()).toBe(false);
  });

  it('uses_idle_callback_when_present', () => {
    const ric = vi.fn<(cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void, o: { timeout: number }) => void>();
    vi.stubGlobal('requestIdleCallback', ric);
    enqueue(() => true);
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 50 });
    ric.mock.calls[0][0]({ didTimeout: false, timeRemaining: () => 10 });
    expect(isQueuePending()).toBe(false);
  });
});

describe('idleQueue 바쁜 페이지', () => {
  it('idle 콜백이 한 번도 안 불려도 1초에 15 조각 이상 돈다', () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn(() => 1),
    ); // 바쁜 페이지: 끝내 안 불린다
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let n = 0;
    for (let i = 0; i < 1000; i++)
      enqueue(() => {
        n++;
        clock += 5; // step 하나가 조각(4ms)을 다 쓴다 → 조각당 step 하나
        return true;
      });
    vi.advanceTimersByTime(1000);
    now.mockRestore();
    expect(n).toBeGreaterThanOrEqual(15);
  });
});

describe('idleQueue 가드', () => {
  it('끝나지 않는 step 은 버려져 뒤의 step 이 돈다', () => {
    let after = false;
    enqueue(() => false);
    enqueue(() => (after = true));
    expect(flushQueue()).toBe(true);
    expect(after).toBe(true);
  });
});
