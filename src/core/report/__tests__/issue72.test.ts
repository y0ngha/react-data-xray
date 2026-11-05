import { describe, expect, it } from 'vitest';

import type { RdxReport } from '../buildReport.js';
import { compare, toComparable, type ComparableReport } from '../compare.js';
import { MAX_FETCH_CAUSES } from '../reactQuerySection.js';
import { MAX_COMPARABLE_RENDER_ROWS, MAX_RENDER_GROUPS } from '../renderSection.js';

type Row = ComparableReport['renders']['components'][number];

const row = (name: string, avoidable: number, renders = avoidable + 1, extra: Partial<Row> = {}): Row => ({
  name,
  renders,
  avoidable,
  ...extra,
});

const side = (
  components: Row[],
  extra: Partial<ComparableReport['renders']> = {},
  rest: Partial<ComparableReport> = {},
): ComparableReport => ({
  requests: { endpoints: [] },
  renders: { monitoring: true, windowSeconds: 10, components, omitted: { components: 0, renders: 0, avoidable: 0 }, ...extra },
  reactQuery: { findings: [], fetchCauses: [] },
  ...rest,
});

// 순위 1..n 의 컴포넌트(avoidable 이 큰 순)
const ranked = (n: number, prefix = 'C'): Row[] => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, 100 - i));

describe('상한 밖 행 (#72)', () => {
  it('cap_unknown: 한쪽에서 상한 밖으로 빠졌을 수 있는 행은 removed 가 아니라 unknown 이고 증감을 지어내지 않는다', () => {
    const before = side(ranked(MAX_RENDER_GROUPS), { omitted: { components: 5, renders: 10, avoidable: 5 } });
    // 고친 뒤 새 컴포넌트가 순위에 올라 C29 가 밀렸다.
    const after = side([row('New', 200), ...ranked(MAX_RENDER_GROUPS - 1)], { omitted: { components: 6, renders: 20, avoidable: 6 } });
    const r = compare(before, after);
    expect(r.renders.find((c) => c.name === 'C29')).toEqual({
      name: 'C29',
      status: 'unknown',
      verdict: 'unknown',
      before: { renders: 72, avoidable: 71 },
    });
    expect(r.renders.find((c) => c.name === 'New')).toMatchObject({ status: 'unknown', verdict: 'unknown', after: { avoidable: 200 } });
    expect(r.renders.some((c) => c.status === 'removed')).toBe(false);
    expect(r.warnings).toContain(
      '2 row(s) have status unknown: one report left them out at its row limit, so whether they changed cannot be told (their known values are in before/after)',
    );
  });

  it('cap_removed: 상대 쪽이 모든 행을 담았으면 한쪽에만 있는 행은 정말 사라진 것이다', () => {
    const r = compare(side([row('Gone', 3)]), side([]));
    expect(r.renders).toEqual([{ name: 'Gone', status: 'removed', verdict: 'improved', renders: -4, avoidable: -3 }]);
  });

  it('old_snapshot_cap: omitted 가 없는 옛 스냅샷은 상한만큼 찼으면 빠진 행이 있었을 수 있다고 본다', () => {
    const old = side(ranked(MAX_RENDER_GROUPS), { omitted: undefined });
    const r = compare(old, side([row('Fresh', 1)]));
    expect(r.renders.find((c) => c.name === 'Fresh')?.status).toBe('unknown');
    expect(r.totals.renders.verdict).toBe('unknown');
    const small = side([row('A', 1)], { omitted: undefined });
    expect(compare(small, side([row('Fresh', 1)])).renders.find((c) => c.name === 'Fresh')?.status).toBe('added');
  });
});

describe('행 판정과 합계 (#72)', () => {
  it('row_verdict: 낭비가 줄면 improved, 늘면 regressed, 낭비가 같으면 전체 수로 가른다', () => {
    const r = compare(
      side([row('Less', 5, 10), row('More', 1, 2), row('Busier', 0, 3), row('Same', 2, 4, { totalMs: 1 })]),
      side([row('Less', 1, 10), row('More', 4, 5), row('Busier', 0, 7), row('Same', 2, 4, { totalMs: 9 })]),
    );
    expect(r.renders).toEqual([
      { name: 'Less', verdict: 'improved', avoidable: -4 },
      { name: 'More', verdict: 'regressed', renders: 3, avoidable: 3 },
      { name: 'Busier', verdict: 'regressed', renders: 4 },
    ]);
  });

  it('render_time: 렌더 수가 달라진 행에는 totalMs 증감을 싣고, 합계에 renderMs 를 둔다', () => {
    const r = compare(side([row('A', 2, 4, { totalMs: 3.2 })]), side([row('A', 1, 3, { totalMs: 1.1 })]));
    expect(r.renders).toEqual([{ name: 'A', verdict: 'improved', renders: -1, avoidable: -1, totalMs: -2.1 }]);
    expect(r.totals.renderMs).toEqual({ before: 3.2, after: 1.1, delta: -2.1 });
    expect(compare(side([row('A', 2)]), side([row('A', 1)])).totals.renderMs).toBeUndefined();
  });

  it('request_verdict: 요청 행은 review·failedDuplicates 도 비교하고 낭비(duplicates + sameResponses)로 판정한다', () => {
    const ep = (endpoint: string, count: number, duplicates: number, sameResponses: number, review = 0, failedDuplicates = 0) => ({
      endpoint,
      count,
      duplicates,
      sameResponses,
      review,
      failedDuplicates,
    });
    const r = compare(
      side([], {}, { requests: { endpoints: [ep('GET /a', 10, 4, 2, 1, 2), ep('GET /b', 3, 0, 0), ep('GET /poll', 5, 0, 0, 4)] } }),
      side([], {}, { requests: { endpoints: [ep('GET /a', 12, 1, 0, 1, 0), ep('GET /b', 3, 1, 0), ep('GET /poll', 5, 0, 0, 1)] } }),
    );
    expect(r.requests).toEqual([
      { endpoint: 'GET /a', verdict: 'improved', count: 2, duplicates: -3, sameResponses: -2, failedDuplicates: -2 },
      { endpoint: 'GET /b', verdict: 'regressed', duplicates: 1 },
      { endpoint: 'GET /poll', verdict: 'unchanged', review: -3 },
    ]);
    expect(r.totals.requests).toEqual({ before: 18, after: 20, delta: 2, verdict: 'regressed' });
    expect(r.totals.wastedRequests).toEqual({ before: 6, after: 2, delta: -4, verdict: 'improved' });
  });

  it('render_totals: 렌더 합계는 상한 밖 행(omitted)까지 더한다', () => {
    const r = compare(
      side([row('A', 5, 10)], { omitted: { components: 3, renders: 6, avoidable: 3 } }),
      side([row('A', 5, 10)], { omitted: { components: 1, renders: 2, avoidable: 0 } }),
    );
    expect(r.totals.renders).toEqual({ before: 16, after: 12, delta: -4, verdict: 'improved' });
    expect(r.totals.avoidable).toEqual({ before: 8, after: 5, delta: -3, verdict: 'improved' });
    expect(compare(side([]), side([])).totals.avoidable.verdict).toBe('unchanged');
  });

  it('fetch_causes: React Query fetch 원인별 수를 비교하고, 상한까지 찬 쪽에서 빠진 원인은 unknown 이다', () => {
    const fc = (queryKey: string, count: number, wasteful = false) => ({
      queryKey,
      observer: 'List',
      cause: 'mount',
      count,
      ...(wasteful && { wasteful: true as const }),
    });
    const r = compare(
      side([], {}, { reactQuery: { findings: [], fetchCauses: [fc('["a"]', 5, true), fc('["b"]', 1)] } }),
      side([], {}, { reactQuery: { findings: [], fetchCauses: [fc('["a"]', 1, true), fc('["b"]', 1)] } }),
    );
    expect(r.reactQuery.fetchCauses).toEqual([
      { queryKey: '["a"]', observer: 'List', cause: 'mount', wasteful: true, verdict: 'improved', count: -4 },
    ]);
    const full = Array.from({ length: MAX_FETCH_CAUSES }, (_, i) => fc(`["k${i}"]`, 30 - i));
    const capped = compare(
      side([], {}, { reactQuery: { findings: [], fetchCauses: full } }),
      side([], {}, { reactQuery: { findings: [], fetchCauses: [fc('["new"]', 1)] } }),
    );
    expect(capped.reactQuery.fetchCauses.find((c) => c.queryKey === '["new"]')?.status).toBe('unknown');
    // 이 필드 전에 저장한 스냅샷과는 비교하지 않는다.
    expect(compare(side([], {}, { reactQuery: { findings: [] } }), side([])).reactQuery.fetchCauses).toEqual([]);
  });
});

describe('측정 조건 경고 (#72)', () => {
  it('page_warning: 두 보고서의 page 가 다르면 경고하고, page 가 없는 옛 스냅샷과는 보지 않는다', () => {
    expect(compare(side([], {}, { page: '/a' }), side([], {}, { page: '/b' })).warnings).toEqual([
      'pages differ (/a / /b); the reports may measure different screens',
    ]);
    expect(compare(side([], {}, { page: '/a' }), side([], {}, { page: '/a' })).warnings).toEqual([]);
    expect(compare(side([]), side([], {}, { page: '/a' })).warnings).toEqual([]);
  });

  it('truncated_warning: 인스턴스 상한에 걸린 보고서가 있으면 어느 쪽인지 경고한다', () => {
    const t = { truncated: true, droppedInstances: 12 };
    expect(compare(side([]), side([], t)).warnings).toEqual([
      'render instances were truncated in after (droppedInstances 0 / 12); render counts leave out the least-rendered instances',
    ]);
    expect(compare(side([], t), side([], t)).warnings[0]).toContain('truncated in both reports');
    expect(compare(side([], { truncated: false }), side([], { truncated: false })).warnings).toEqual([]);
  });
});

describe('toComparable·스냅샷 크기 (#72)', () => {
  const report = (components: Row[], omitted: RdxReport['renders']['omitted']): RdxReport =>
    ({
      page: '/list',
      requests: { endpoints: [{ endpoint: 'GET /x', count: 1, duplicates: 0, sameResponses: 0, failedDuplicates: 0, review: 0 }] },
      renders: {
        monitoring: true,
        windowSeconds: 10,
        truncated: false,
        droppedInstances: 0,
        omitted,
        components: components.map((c) => ({ ...c, time: c.totalMs === undefined ? undefined : { totalMs: c.totalMs } })),
      },
      reactQuery: {
        findings: [],
        fetchCauses: [
          { queryKey: '["a"]', observer: 'List', cause: 'mount', causeLabel: 'x', evidence: 'long text', count: 2, fix: 'long fix' },
        ],
      },
    }) as unknown as RdxReport;

  it('파일에서 읽은 보고서(상한 밖 행 없음)는 보고서의 omitted 를 그대로 남기고, page·fetchCauses 를 줄여 담는다', () => {
    const c = toComparable(report([row('A', 1, 2, { totalMs: 0.5 })], { components: 4, renders: 9, avoidable: 2 }));
    expect(c.page).toBe('/list');
    expect(c.renders.omitted).toEqual({ components: 4, renders: 9, avoidable: 2 });
    expect(c.renders.components).toEqual([{ name: 'A', renders: 2, avoidable: 1, totalMs: 0.5 }]);
    expect(c.reactQuery.fetchCauses).toEqual([{ queryKey: '["a"]', observer: 'List', cause: 'mount', count: 2, wasteful: true }]);
  });

  it('snapshot_size: 상한까지 행을 담은 스냅샷 6개가 sessionStorage 에 들어간다', () => {
    const name = (i: number) => `SomeFairlyLongComponentName${i}`;
    const rows = Array.from({ length: MAX_COMPARABLE_RENDER_ROWS }, (_, i) =>
      row(name(i), 500 - i, 900, { renderedAt: `src/features/some/deep/folder/Component${i}.tsx:123:45`, totalMs: 12.3 }),
    );
    const c: ComparableReport = side(rows);
    const size = JSON.stringify(c).length;
    expect(size).toBeLessThan(40_000);
    // 6개를 다 둔 sessionStorage 값도 브라우저 한도(대개 5MB)의 한 귀퉁이다.
    const six = Object.fromEntries(['s1', 's2', 's3', 's4', 's5', 's6'].map((n) => [n, c]));
    expect(JSON.stringify(six).length).toBeLessThan(250_000);
  });
});
