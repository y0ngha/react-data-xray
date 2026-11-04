import { describe, expect, it } from 'vitest';

import { buildBoxIndex } from '../boxIndex.js';
import type { RequestClass } from '../classify.js';
import type { RequestRecord } from '../types.js';

const rec = (id: number, url: string, startedAt: number, load?: number): RequestRecord => ({
  id,
  kind: 'fetch',
  method: 'GET',
  url,
  status: 200,
  startedAt,
  durationMs: 1,
  body: undefined,
  ...(load === undefined ? {} : { load }),
});

describe('buildBoxIndex (#64)', () => {
  it('출처 이후(출처 포함)에 같은 요청의 낭비가 있으면 빨강이다', () => {
    const source = rec(1, '/a', 100);
    const index = buildBoxIndex([source, rec(2, '/a', 200), rec(3, '/a', 300)], new Map<number, RequestClass>([[3, 'same-response']]));
    expect(index.isWastefulSince(source)).toBe(true);
    expect(index.statOf(source)).toMatchObject({ count: 3, sameResponses: 1 });
  });

  it('출처 자신이 낭비여도 빨강이다', () => {
    const source = rec(2, '/a', 200);
    expect(buildBoxIndex([rec(1, '/a', 100), source], new Map([[2, 'duplicate']])).isWastefulSince(source)).toBe(true);
  });

  it('출처보다 앞선 낭비, 다른 load, 다른 payload 는 보지 않는다', () => {
    const source = rec(3, '/a?page=1', 300, 2);
    const records = [rec(1, '/a?page=1', 100, 2), rec(2, '/a?page=1', 400, 1), source, rec(4, '/a?page=2', 500, 2)];
    const index = buildBoxIndex(
      records,
      new Map<number, RequestClass>([
        [1, 'duplicate'],
        [2, 'duplicate'],
        [4, 'duplicate'],
      ]),
    );
    expect(index.isWastefulSince(source)).toBe(false);
    // 지표는 그 요청의 기록 전체(다른 load 포함)를 센다.
    expect(index.statOf(source)).toMatchObject({ count: 3, duplicates: 2 });
  });

  it('load 가 없으면 0 으로 본다', () => {
    const source = rec(1, '/a', 100);
    expect(buildBoxIndex([source, rec(2, '/a', 200, 0)], new Map([[2, 'duplicate']])).isWastefulSince(source)).toBe(true);
  });

  it('기록에 없는 출처도 키를 계산해 찾는다', () => {
    const index = buildBoxIndex([rec(2, '/a', 200)], new Map([[2, 'duplicate']]));
    expect(index.isWastefulSince(rec(1, '/a', 100))).toBe(true);
    expect(index.statOf(rec(1, '/a', 100))).toMatchObject({ count: 1 });
  });
});
