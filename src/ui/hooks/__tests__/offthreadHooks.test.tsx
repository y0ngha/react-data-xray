import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tr: vi.fn<() => void>(),
  collect: vi.fn<() => unknown>(),
  commit: null as null | (() => void),
  store: null as null | (() => void),
  version: 0,
  records: [] as unknown[],
}));
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  return { ...actual, startTransition: (fn: () => void) => (h.tr(), actual.startTransition(fn)) };
});
vi.mock('../../../core/inspect/boxes.js', () => ({ collectBoxes: h.collect }));
vi.mock('../../../core/inspect/derivedMatch.js', () => ({ isIndexPending: () => false }));
vi.mock('../../../core/render/monitor.js', () => ({
  subscribeCommits: (f: () => void) => ((h.commit = f), () => undefined),
  setRenderMonitoring: () => undefined,
}));
vi.mock('../useRenderMonitoring.js', () => ({ useRenderMonitoring: () => undefined }));
vi.mock('../../../core/requests/store.js', () => ({
  subscribe: (f: () => void) => ((h.store = f), () => undefined),
  getStoreVersion: () => h.version,
  getRecords: () => h.records,
}));

import { flushQueue } from '../../../core/scheduler/idleQueue.js';
import { useNow } from '../useNow.js';
import { useOverlayBoxes } from '../useOverlayBoxes.js';
import { useRecords } from '../useRecords.js';

beforeEach(() => void flushQueue()); // setup 이 남긴 step 이 큐 머리에 있으면 이 파일의 step 이 안 돈다

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.collect.mockReset();
  h.tr.mockClear();
});

describe('records_transition', () => {
  it('store 변경이 몰려도 rAF 한 번에 transition 으로 한 번 새 복사본을 받는다', () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(() => cb(0), 0) as unknown as number);
    const { result } = renderHook(() => useRecords());
    const first = result.current;
    act(() => {
      h.store?.();
      h.store?.();
      h.store?.();
    });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(first);
    act(() => void vi.runAllTimers());
    expect(result.current).not.toBe(first);
    expect(h.tr).toHaveBeenCalledTimes(1);
  });
});

describe('records_gap', () => {
  it('렌더와 구독 사이에 store 가 바뀌었으면 구독 직후 갱신한다', () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(() => cb(0), 0) as unknown as number);
    h.version = 0;
    let first: unknown;
    const { result } = renderHook(() => {
      const records = useRecords();
      first ??= records;
      h.version = 1; // 렌더 뒤 effect 전에 store 가 바뀐 것을 흉내 낸다
      return records;
    });
    act(() => void vi.runAllTimers());
    expect(result.current).not.toBe(first);
  });
});

describe('now_transition', () => {
  it('setNow 는 startTransition 안에서 한다', () => {
    vi.useFakeTimers();
    renderHook(() => useNow(100));
    act(() => void vi.advanceTimersByTime(100));
    expect(h.tr).toHaveBeenCalledTimes(1);
  });
});

describe('boxes_collected_in_queue', () => {
  const box = { id: 1 } as never;
  it('deferred 면 같은 step 을 이어 하고 끝나면 transition 으로 반영한다', () => {
    vi.useFakeTimers();
    h.collect.mockReturnValueOnce({ boxes: [], deferred: true }).mockReturnValue({ boxes: [box], deferred: false });
    const { result } = renderHook(() => useOverlayBoxes(true, null));
    act(() => void vi.advanceTimersByTime(0));
    expect(h.collect).not.toHaveBeenCalled(); // 큐에 넣기만 했거나 아직 안 돌았다
    act(() => void flushQueue(0));
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.collect).toHaveBeenCalledWith(expect.any(Function), 4, undefined);
    expect(result.current).toEqual([]);
    act(() => void flushQueue());
    expect(h.collect).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([box]);
  });

  it('collectBoxes 가 던져도 다음 commit 이 다시 모은다', () => {
    vi.useFakeTimers();
    h.collect
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockReturnValue({ boxes: [box], deferred: false });
    const { result } = renderHook(() => useOverlayBoxes(true, null));
    act(() => void vi.advanceTimersByTime(0));
    act(() => void flushQueue());
    expect(h.collect).toHaveBeenCalledTimes(1);
    act(() => {
      h.commit?.();
      vi.advanceTimersByTime(1000);
    });
    act(() => void flushQueue());
    expect(h.collect).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([box]);
  });

  it('언마운트 뒤 끝나는 step 은 setState 하지 않는다', () => {
    vi.useFakeTimers();
    h.collect.mockReturnValue({ boxes: [box], deferred: false });
    const err = vi.spyOn(console, 'error');
    const { unmount } = renderHook(() => useOverlayBoxes(true, null));
    act(() => void vi.advanceTimersByTime(0));
    unmount();
    flushQueue();
    expect(h.collect).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('step 이 큐에 있는 동안 commit 이 와도 두 번째 step 을 넣지 않고, 끝난 뒤 한 번 더 모은다', () => {
    vi.useFakeTimers();
    h.collect.mockReturnValueOnce({ boxes: [], deferred: true }).mockReturnValue({ boxes: [box], deferred: false });
    renderHook(() => useOverlayBoxes(true, null));
    act(() => void vi.advanceTimersByTime(0));
    act(() => void flushQueue(0)); // deferred 로 남음
    act(() => {
      h.commit?.();
      vi.advanceTimersByTime(5000);
    });
    act(() => void flushQueue());
    expect(h.collect).toHaveBeenCalledTimes(2); // 같은 step 의 이어하기뿐
    act(() => void vi.advanceTimersByTime(1000));
    act(() => void flushQueue());
    expect(h.collect).toHaveBeenCalledTimes(3);
  });

  it('계속 deferred 여도 무한히 잇지 않고 직전 결과를 반영한다', () => {
    vi.useFakeTimers();
    h.collect.mockReturnValue({ boxes: [box], deferred: true });
    const { result } = renderHook(() => useOverlayBoxes(true, null));
    act(() => void vi.advanceTimersByTime(0));
    act(() => void flushQueue());
    expect(h.collect.mock.calls.length).toBeLessThanOrEqual(50);
    expect(result.current).toEqual([box]);
  });

  it('상한에 걸려 덜 모았으면 commit 이 없어도 평소 간격 뒤에 다시 모아 전체를 반영한다', () => {
    vi.useFakeTimers();
    const partial = { boxes: [box], deferred: true };
    const full = [box, { id: 2 } as never];
    let calls = 0;
    h.collect.mockImplementation(() => (++calls <= 50 ? partial : { boxes: full, deferred: false }));
    const { result } = renderHook(() => useOverlayBoxes(true, null));
    act(() => void vi.advanceTimersByTime(0));
    act(() => void flushQueue());
    expect(result.current).toEqual([box]);
    act(() => void vi.advanceTimersByTime(1000));
    act(() => void flushQueue());
    expect(result.current).toEqual(full);
  });
});
