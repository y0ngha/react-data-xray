import { createHash } from 'node:crypto';

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { useProblemSignal } from '../../../ui/hooks/useProblemSignal.js';
import { resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { classifyRecords } from '../../requests/classify.js';
import { getEndpointStats, isWastefulStat } from '../../requests/endpointStats.js';
import { getRecords } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildReport, HOW_TO_READ, HOW_TO_READ_VERSION } from '../buildReport.js';
import { toComparable } from '../compare.js';
import type { ReactQuerySection } from '../reactQuerySection.js';
import type { RenderSection } from '../renderSection.js';
import type { RequestSection } from '../requestSection.js';
import { installReportApi } from '../reportApi.js';
import { buildSummary } from '../summarySection.js';

type Endpoint = RequestSection['endpoints'][number];
type Component = RenderSection['components'][number];

const endpoint = (name: string, duplicates: number, sameResponses: number, extra: Partial<Endpoint> = {}): Endpoint => ({
  endpoint: name,
  ignored: false,
  count: duplicates + sameResponses + 1,
  restoredCount: 0,
  avgMs: 10,
  duplicates,
  sameResponses,
  failedDuplicates: 0,
  review: 0,
  callers: [{ frame: 'at load (src/api.ts:3:1)', count: 2, component: 'List' }],
  wasteExamples: [],
  ...extra,
});
const component = (name: string, renders: number, avoidable: number, extra: Partial<Component> = {}): Component => ({
  name,
  instances: 1,
  renders,
  avoidable,
  memoized: false,
  reasons: {},
  changedProps: { sameContent: [], newCallback: [], context: [] },
  causedBy: [],
  stateChanges: [],
  networkCauses: [],
  advice: [],
  ...extra,
});
const requests = (endpoints: Endpoint[]): RequestSection => ({ total: 0, dropped: 0, endpoints });
const renders = (components: Component[], monitoring = true): RenderSection => ({
  monitoring,
  windowSeconds: 10,
  truncated: false,
  droppedInstances: 0,
  components,
});
const noQuery: ReactQuerySection = { found: false, findings: [] };

describe('보고서 summary (#70)', () => {
  it('summary_rank: 배지가 세는 것(high)을 먼저, 그 안에서 요청 → 렌더, 그다음 절감 큰 순으로 놓고 상세 경로를 가리킨다', () => {
    const rq: ReactQuerySection = {
      found: true,
      findings: [
        { kind: 'invalidate-unloaded', keys: ['["x"]'], requests: [], title: '', fix: '' },
        { kind: 'stale-zero', keys: ['["todos"]'], requests: ['GET /api/todos'], title: 't', fix: 'Increase staleTime.' },
      ],
    };
    const s = buildSummary(
      requests([endpoint('GET /api/ok', 0, 0), endpoint('GET /api/small', 1, 0), endpoint('GET /api/big', 1, 4)]),
      rq,
      renders([
        component('Calm', 5, 3, { renderedAt: 'src/App.tsx:4:3', time: { totalMs: 5, avgMs: 1, avoidableMs: 3 } }),
        component('Storm', 30, 0, { advice: ['Move the timer state down.'] }),
        component('Swapped', 2, 0, { mounts: { mounts: 3, unmounts: 2, remounts: [{ parent: 'Page', count: 2 }] } }),
      ]),
      new Map([['Storm', 30]]),
    );
    expect(s.topFindings.map((f) => [f.kind, f.severity, f.target.endpoint ?? f.target.component ?? f.target.queryKeys?.[0]])).toEqual([
      ['same-response', 'high', 'GET /api/big'],
      ['duplicate', 'high', 'GET /api/small'],
      ['render-storm', 'high', 'Storm'],
      ['react-query', 'medium', '["todos"]'],
      ['avoidable-renders', 'medium', 'Calm'],
      ['remount', 'medium', 'Swapped'],
    ]);
    expect(s.topFindings[0]).toMatchObject({
      target: { endpoint: 'GET /api/big', component: 'List', location: 'at load (src/api.ts:3:1)' },
      evidence: { duplicates: 1, sameResponses: 4 },
      savings: { requests: 5, ms: 50 },
      detail: 'requests.endpoints[2]',
    });
    expect(s.topFindings[3]).toMatchObject({ rule: 'stale-zero', fix: 'Increase staleTime.', detail: 'reactQuery.findings[1]' });
    expect(s.topFindings[4]).toMatchObject({
      target: { location: 'src/App.tsx:4:3' },
      savings: { renders: 3, ms: 3 },
      detail: 'renders.components[0]',
    });
    expect(s.topFindings[5].detail).toBe('renders.components[2].mounts');
    expect(s.badge).toEqual({ issues: 3, wasteEndpoints: 2, stormingComponents: 1 });
    expect(s.verdict).toBe(
      '2 endpoints with wasted requests (6 requests), 1 component with avoidable renders (3 renders, 3ms), 1 React Query finding, RDX badge 3',
    );
    expect(s.omitted).toBe(0);
  });

  it('summary_skip: 무시한 엔드포인트는 빼고, 10개까지만 싣고 나머지 수를 남기며, 보고서 행에 없는 폭주도 남긴다', () => {
    const many = Array.from({ length: 12 }, (_, i) => endpoint(`GET /api/${i}`, i + 1, 0));
    const s = buildSummary(
      requests([endpoint('GET /api/ignored', 0, 0, { ignored: true }), ...many]),
      noQuery,
      renders([]),
      new Map([['Ticker', 12]]),
    );
    expect(s.topFindings).toHaveLength(10);
    expect(s.omitted).toBe(3);
    expect(s.topFindings.some((f) => f.target.endpoint === 'GET /api/ignored')).toBe(false);
    expect(s.topFindings[0].target.endpoint).toBe('GET /api/11');
    expect(s.badge.issues).toBe(13);
    // 요청이 앞서므로 상위 10개에 들지 못한 폭주는 omitted 에 든다
    const only = buildSummary(requests([]), noQuery, renders([]), new Map([['Ticker', 12]]));
    expect(only.topFindings).toEqual([
      { kind: 'render-storm', severity: 'high', target: { component: 'Ticker' }, evidence: { rendersLast10s: 12 } },
    ]);
  });

  it('summary_empty: 문제가 없으면 빈 목록과 0 판정, 렌더 감시가 꺼졌으면 판정에 적는다', () => {
    const s = buildSummary(requests([]), noQuery, renders([], false), new Map());
    expect(s).toEqual({
      verdict:
        '0 endpoints with wasted requests (0 requests), 0 components with avoidable renders (0 renders), 0 React Query findings, RDX badge 0 (render monitoring was off)',
      badge: { issues: 0, wasteEndpoints: 0, stormingComponents: 0 },
      topFindings: [],
      omitted: 0,
    });
  });
});

let tick: (() => void) | null = null;
const Ticker = () => {
  const [n, set] = useState(0);
  useEffect(() => {
    tick = () => set((v) => v + 1);
  }, []);
  return <span>{n}</span>;
};

describe('배지와 보고서가 같은 기준을 쓴다 (#70)', () => {
  afterEach(() => {
    cleanup();
    resetRenderStats();
    setRenderMonitoring(false);
    vi.useRealTimers();
  });

  it('badge_agrees: 낭비 엔드포인트와 렌더 폭주 컴포넌트 수가 RDX 버튼 배지와 summary.badge 에서 같다', async () => {
    const load = () => fetch('/api/dup70').then((r) => r.json());
    await [0, 1].reduce((prev) => prev.then(load), Promise.resolve());
    await flush();
    setRenderMonitoring(true);
    render(<Ticker />);
    for (let i = 0; i < 12; i++) act(() => tick!());
    flushQueue();

    const records = getRecords();
    const classes = classifyRecords(records, new Set());
    const wasteCount = getEndpointStats(records, classes).filter(isWastefulStat).length;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { result } = renderHook(() => useProblemSignal(records, (r) => classes.get(r.id) ?? 'ok', wasteCount));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const { summary } = buildReport(true);
    expect(result.current.stormingNames).toContain('Ticker');
    expect(summary.badge).toEqual({ issues: result.current.issues, wasteEndpoints: 1, stormingComponents: 1 });
    expect(summary.topFindings.slice(0, 2).map((f) => [f.kind, f.severity])).toEqual([
      ['duplicate', 'high'],
      ['render-storm', 'high'],
    ]);
  });
});

describe('howToRead 판과 빼기 (#70)', () => {
  it('report_order: summary 가 보고서 맨 앞이고 howToRead 는 summary 를 먼저 읽으라고 시작한다', () => {
    const r = buildReport(false, 0, false);
    expect(Object.keys(r).slice(0, 3)).toEqual(['summary', 'howToReadVersion', 'howToRead']);
    expect(r.howToRead?.[0]).toMatch(/^Read summary first/);
    expect(r.howToReadVersion).toBe(HOW_TO_READ_VERSION);
  });

  it('how_to_read_version: 문구를 바꾸면 HOW_TO_READ_VERSION 도 올린다', () => {
    // 이 해시가 틀리면 HOW_TO_READ 문구가 바뀐 것이다. HOW_TO_READ_VERSION 을 올리고 두 값을 함께 고친다.
    const hash = createHash('sha256').update(HOW_TO_READ.join('\n')).digest('hex').slice(0, 12);
    expect({ version: HOW_TO_READ_VERSION, hash }).toEqual({ version: 2, hash: '3b9ab94f68b5' });
  });

  it('report_without_how_to_read: report({ howToRead: false }) 는 howToRead 만 빼고 판은 남긴다', () => {
    installReportApi();
    const full = window.__RDX__!.report();
    const short = window.__RDX__!.report({ howToRead: false });
    expect(full.howToRead).toEqual(HOW_TO_READ);
    expect(short).not.toHaveProperty('howToRead');
    expect(short.howToReadVersion).toBe(HOW_TO_READ_VERSION);
    expect(short.summary).toBeDefined();
  });

  it('compare_ignores_summary: 비교용 보고서에는 summary·howToRead 가 들어가지 않는다', () => {
    const c = toComparable(buildReport(false, 0, false));
    expect(Object.keys(c).sort()).toEqual(['reactQuery', 'renders', 'requests', 'resetAt']);
  });
});
