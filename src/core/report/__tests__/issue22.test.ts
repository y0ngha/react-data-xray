import { describe, expect, it } from 'vitest';

import type { RdxReport } from '../buildReport.js';
import { compare } from '../compare.js';

const ep = (endpoint: string, count: number, duplicates: number, sameResponses = 0) => ({ endpoint, count, duplicates, sameResponses });
const make = (
  endpoints: ReturnType<typeof ep>[],
  components: Array<{ name: string; renders: number; avoidable: number }> = [],
  windowSeconds = 10,
  findings: Array<{ kind: string; keys: string[] }> = [],
) =>
  ({
    requests: { endpoints },
    renders: { monitoring: true, windowSeconds, components },
    reactQuery: { findings },
  }) as unknown as RdxReport;

describe('compare', () => {
  it('엔드포인트별 증감만 담는다', () => {
    const r = compare(make([ep('GET /x', 5, 4)]), make([ep('GET /x', 5, 1)]));
    expect(r.requests).toEqual([{ endpoint: 'GET /x', duplicates: -3 }]);
  });
  it('missing_section: 한쪽에만 있는 엔드포인트와 컴포넌트는 추가·제거로', () => {
    const r = compare(make([ep('GET /old', 2, 1)], [{ name: 'A', renders: 9, avoidable: 5 }]), make([ep('GET /new', 3, 0)]));
    expect(r.requests).toEqual([
      { endpoint: 'GET /old', status: 'removed', count: -2, duplicates: -1 },
      { endpoint: 'GET /new', status: 'added', count: 3 },
    ]);
    expect(r.renders).toEqual([{ name: 'A', status: 'removed', renders: -9, avoidable: -5 }]);
  });
  it('React Query 지적의 새로 생김과 해결', () => {
    const r = compare(make([], [], 10, [{ kind: 'k1', keys: ['"a"'] }]), make([], [], 10, [{ kind: 'k2', keys: ['"b"'] }]));
    expect(r.reactQuery).toEqual({ added: ['k2 "b"'], resolved: ['k1 "a"'] });
  });
  it('측정 구간이 다르면 경고', () => {
    expect(compare(make([], [], 10), make([], [], 120)).warnings).toEqual(['measurement windows differ (10s / 120s)']);
    expect(compare(make([], [], 10), make([], [], 10)).warnings).toEqual([]);
  });
});
