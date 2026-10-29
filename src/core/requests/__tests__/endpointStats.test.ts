import { describe, expect, it } from 'vitest';

import type { RequestClass } from '../classify.js';
import { getEndpointStats, isWastefulStat, statSummary, wasteCount } from '../endpointStats.js';
import type { RequestRecord } from '../types.js';

const rec = (id: number, url: string, durationMs: number): RequestRecord => ({
  id,
  kind: 'fetch',
  method: 'GET',
  url,
  status: 200,
  startedAt: 0,
  durationMs,
  body: undefined,
});

describe('getEndpointStats', () => {
  it('엔드포인트별로 호출 수, 평균 시간, 분류별 수를 세고 낭비가 많은 순으로 정렬한다', () => {
    const records = [rec(1, '/a?x=1', 10), rec(2, '/a?x=2', 30), rec(3, '/b', 5), rec(4, '/b', 5), rec(5, '/b', 5), rec(6, '/b', 5)];
    const classes = new Map<number, RequestClass>([
      [2, 'duplicate'],
      [4, 'periodic'],
      [5, 'strict-mode'],
      [6, 'ignored'],
    ]);
    const [first, second] = getEndpointStats(records, classes);
    expect(first).toEqual({ endpoint: 'GET /a', count: 2, duplicates: 1, sameResponses: 0, review: 0, explained: 0, avgMs: 20 });
    expect(second).toMatchObject({ endpoint: 'GET /b', count: 4, review: 1, explained: 2 });
    expect(wasteCount(first)).toBe(1);
    expect(isWastefulStat(first)).toBe(true);
    expect(isWastefulStat(second)).toBe(false);
    expect(isWastefulStat(undefined)).toBe(false);
  });
});

describe('statSummary', () => {
  it('호출 수와 낭비만 짧게 적고, 한 번만 불린 정상 요청은 비운다', () => {
    const stat = { endpoint: 'GET /a', count: 6, duplicates: 2, sameResponses: 3, review: 0, explained: 0, avgMs: 10 };
    expect(statSummary(stat)).toBe('×6 · duplicates 2 · same response 3');
    expect(statSummary({ ...stat, duplicates: 0, sameResponses: 0 })).toBe('×6');
    expect(statSummary({ ...stat, count: 1, duplicates: 0, sameResponses: 0 })).toBe('');
    expect(statSummary(undefined)).toBe('');
  });
});
