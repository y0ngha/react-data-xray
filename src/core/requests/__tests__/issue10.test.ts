import { describe, expect, it } from 'vitest';

import { isFailed, type RequestClass } from '../classify.js';
import { getEndpointStats } from '../endpointStats.js';
import type { RequestRecord } from '../types.js';

const rec = (id: number, status: number, error?: string): RequestRecord => ({
  id,
  kind: 'fetch',
  method: 'GET',
  url: '/api/a',
  status,
  startedAt: 0,
  durationMs: 10,
  body: undefined,
  ...(error ? { error } : {}),
});

describe('실패 응답의 중복', () => {
  it('503_vs_200: 503 중복만 failedDuplicates 로 세고 duplicates 는 둘 다 센다', () => {
    const classes = new Map<number, RequestClass>([
      [2, 'duplicate'],
      [3, 'duplicate'],
      [4, 'duplicate'],
    ]);
    const [stat] = getEndpointStats([rec(1, 503), rec(2, 503), rec(3, 200), rec(4, 0, 'Failed to fetch')], classes);
    expect(stat.duplicates).toBe(3);
    expect(stat.failedDuplicates).toBe(2);
    expect(stat.failedCodes).toEqual(['503', 'ERR']);
  });

  it('성공 응답의 중복만 있으면 실패 필드가 없다', () => {
    const [stat] = getEndpointStats([rec(1, 200), rec(2, 200)], new Map<number, RequestClass>([[2, 'duplicate']]));
    expect(stat.failedDuplicates).toBeUndefined();
    expect(stat.failedCodes).toBeUndefined();
  });

  it('isFailed: 4xx·5xx 와 네트워크 오류', () => {
    expect([200, 404, 500].map((s) => isFailed(rec(1, s)))).toEqual([false, true, true]);
    expect(isFailed(rec(1, 0, 'x'))).toBe(true);
  });
});
