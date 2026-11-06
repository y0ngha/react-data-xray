import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Fiber } from '../../fiber/types.js';
import { findRecentResponse } from '../../render/networkCause.js';
import { clearRecords, createRecord, finishRecord, registerBody } from '../../requests/store.js';
import { childEntries, isOpaque } from '../../../shared/objectWalk.js';
import { flushIndex } from '../derivedMatch.js';
import { findExactOrigins } from '../exactMatch.js';
import { createFiberHolds, drain } from '../holders.js';

// window 의 속성을 읽으면 세는 getter. Chrome 에서는 fence 같은 지원 중단 API getter 가 이 자리에 있다(#138).
const PROBE = '__rdxProbe';
let reads = 0;

beforeEach(() => {
  reads = 0;
  Object.defineProperty(window, PROBE, { get: () => ++reads, enumerable: true, configurable: true });
  const record = createRecord('fetch', 'GET', '/api/user');
  finishRecord(record, 200);
  registerBody(record, { id: 'user-1234', name: 'Kim', email: 'kim@example.com' });
  flushIndex();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[PROBE];
  clearRecords();
});

const fiberHolding = (value: unknown): Fiber =>
  ({ tag: 0, memoizedProps: { target: value }, memoizedState: { memoizedState: [value], next: null } }) as unknown as Fiber;

describe('브라우저 전역 객체(window)는 펼치지 않는다', () => {
  it('isOpaque 로 거른다', () => {
    expect(isOpaque(window)).toBe(true);
    expect(isOpaque({})).toBe(false);
  });

  it('childEntries 는 window 의 속성을 읽지 않는다(경고가 실제로 나던 곳)', () => {
    expect(childEntries(window, 100)).toEqual([]);
    expect(reads).toBe(0);
    expect(childEntries({ a: 1 }, 100)).toEqual([['.a', 1]]);
  });

  it('요소 클릭의 정확 매칭은 window 를 펼치지도 파생 후보로 넘기지도 않는다', () => {
    const { candidates } = findExactOrigins({ deps: [window], ref: { current: window } }, 'props');
    expect(reads).toBe(0);
    expect(candidates.some((c) => c.value === window)).toBe(false);
  });

  it('렌더 원인 탐색은 window 의 속성을 읽지 않는다', () => {
    findRecentResponse([{ current: window }, [window]], Date.now());
    expect(reads).toBe(0);
  });

  it('소비자 찾기(exact·derived)는 window 의 속성을 읽지 않는다', () => {
    const fiber = fiberHolding(window);
    drain(createFiberHolds('exact')(fiber, new Set(['x'])));
    drain(createFiberHolds('derived')(fiber, new Set(['x'])));
    expect(reads).toBe(0);
  });
});
