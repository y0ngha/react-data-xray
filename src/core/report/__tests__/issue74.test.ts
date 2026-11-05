import { afterEach, describe, expect, it, vi } from 'vitest';

import { ignoreMatcher, IGNORE_KEY } from '../../../shared/ignoredEndpoints.js';
import { layoutTimeline } from '../../../ui/panels/timeline/timelineLayout.js';
import { configure, resetConfig } from '../../config.js';
import { analyzeBursts } from '../../requests/bursts.js';
import { classifyRecords } from '../../requests/classify.js';
import { followUps } from '../../requests/followUps.js';
import { clearRecords, mergeRecords } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { buildReport } from '../buildReport.js';
import type { ReactQuerySection } from '../reactQuerySection.js';
import type { RenderSection } from '../renderSection.js';
import { buildRequestSection, type RequestSection } from '../requestSection.js';
import { buildSummary } from '../summarySection.js';

// #74: 요청 몰림과 변경 뒤 재조회를 패널과 같은 함수로 보고서(requests.bursts·followUps)와 summary 에 싣는다.
let id = 1000;
const rec = (method: string, url: string, startedAt: number, extra: Partial<RequestRecord> = {}): RequestRecord =>
  ({ id: ++id, kind: 'fetch', method, url, status: 200, startedAt, durationMs: 10, body: null, load: 1, ...extra }) as RequestRecord;

/** at 부터 100ms 간격으로 요청 5건(몰림). urls 를 돌아가며 쓴다 */
const burstAt = (at: number, urls: string[], extra?: Partial<RequestRecord>): RequestRecord[] =>
  [0, 100, 200, 300, 400].map((d, i) => rec('GET', urls[i % urls.length], at + d, extra));

const section = (records: RequestRecord[], ignored: ReadonlySet<string> = new Set()): RequestSection =>
  buildRequestSection(records, classifyRecords(records, ignored), ignored, () => undefined);

const noReactQuery: ReactQuerySection = { found: false, findings: [] } as unknown as ReactQuerySection;
const noRenders = { monitoring: true, windowSeconds: 10, components: [] } as unknown as RenderSection;
const summaryOf = (requests: RequestSection) => buildSummary(requests, noReactQuery, noRenders, new Map());

// 페이지 로드에서 멀리 떨어져, 앞뒤 3초 안에 화면 이동이 없는 시각
const FAR = performance.timeOrigin + 600_000;

afterEach(() => {
  vi.useRealTimers();
  resetConfig();
  clearRecords();
  localStorage.removeItem(IGNORE_KEY);
});

describe('requests.bursts (#74)', () => {
  it('타임라인과 같은 analyzeBursts 로 진입·낭비와 근거, 상위 엔드포인트를 싣는다', () => {
    const initial = burstAt(performance.timeOrigin + 500, ['/api/a', '/api/b']);
    const waste = burstAt(FAR, ['/api/items/1', '/api/items/2', '/api/user'], { route: '/list' });
    const records = [...initial, ...waste];
    const { bursts, burstsOmitted } = section(records);
    expect(burstsOmitted).toBe(0);
    // 낭비가 먼저다
    expect(bursts).toEqual([
      {
        from: FAR,
        to: FAR + 400,
        count: 5,
        kind: 'waste',
        reason: 'no-entry',
        wasted: 0,
        route: '/list',
        topEndpoints: [
          { endpoint: 'GET /api/items/:id', endpointId: 'ep:GET /api/items/:id', count: 4 },
          { endpoint: 'GET /api/user', endpointId: 'ep:GET /api/user', count: 1 },
        ],
      },
      expect.objectContaining({ count: 5, kind: 'entry', reason: 'initial-load' }),
    ]);
    // 타임라인이 그리는 몰림과 수·진입 판정이 같다
    const panel = analyzeBursts(records, () => 'ok').map((s) => [s.from, s.records.length, s.entry]);
    const report = [...bursts].sort((a, b) => a.from - b.from).map((b) => [b.from, b.count, b.kind === 'entry']);
    expect(report).toEqual(panel);
    const timeline = layoutTimeline(waste, [], FAR + 1000, 1000, () => 'ok');
    expect(timeline.bursts.map((b) => [b.count, b.initial])).toEqual([[5, false]]);
  });

  it('화면 이동 직후 몰림은 reason navigation 의 진입이다', () => {
    const at = FAR + 100_000;
    vi.useFakeTimers({ toFake: ['Date'], now: at - 200 });
    history.pushState(null, '', `/orders-${at}`);
    const [burst] = section(burstAt(at, ['/api/orders'])).bursts;
    expect(burst).toMatchObject({ kind: 'entry', reason: 'navigation', count: 5 });
    History.prototype.replaceState.call(history, null, '', '/');
  });

  it('무시한 엔드포인트(패널·configure)의 요청은 첫 요청까지 몰림에서 빼고, 타임라인·버튼도 같다', () => {
    const at = FAR + 200_000;
    const panelFirst = rec('GET', '/api/panel', at);
    const codeFirst = rec('GET', '/api/code', at + 50);
    const records = [
      panelFirst,
      codeFirst,
      rec('GET', '/api/panel', at + 100, { duplicateOf: panelFirst.id }),
      rec('GET', '/api/panel', at + 150, { duplicateOf: panelFirst.id }),
      rec('GET', '/api/code', at + 200, { duplicateOf: codeFirst.id }),
      rec('GET', '/api/x', at + 250),
      rec('GET', '/api/y', at + 300),
      rec('GET', '/api/z', at + 350),
    ];
    expect(section(records).bursts[0]).toMatchObject({ count: 8, wasted: 3 });
    configure({ ignore: ['GET /api/code'] });
    // 코드 무시만 있으면 /api/code 두 건(첫 요청 포함)이 빠져 6건이다
    const [burst] = section(records).bursts;
    expect(burst).toMatchObject({ count: 6, wasted: 2 });
    expect(burst.topEndpoints.map((e) => e.endpoint)).not.toContain('GET /api/code');
    // 패널 무시까지 더하면 대부분이 무시한 엔드포인트라 남은 3건은 몰림이 아니다. 타임라인·버튼도 같은 판정이다.
    const panelIgnore = new Set(['GET /api/panel']);
    expect(section(records, panelIgnore).bursts).toEqual([]);
    expect(summaryOf(section(records, panelIgnore)).topFindings.map((f) => f.kind)).not.toContain('request-burst');
    const matcher = ignoreMatcher(panelIgnore);
    const classes = classifyRecords(records, matcher);
    expect(analyzeBursts(records, (r) => classes.get(r.id) ?? 'ok', matcher)).toEqual([]);
    expect(layoutTimeline(records, [], at + 1000, 1000, (r) => classes.get(r.id) ?? 'ok', records, [], matcher).bursts).toEqual([]);
  });

  it('상한(20)을 넘는 구간은 싣지 않고 수만 남긴다', () => {
    const records = Array.from({ length: 22 }, (_, i) => burstAt(FAR + 300_000 + i * 10_000, [`/api/r${i}`])).flat();
    const { bursts, burstsOmitted } = section(records);
    expect(bursts).toHaveLength(20);
    expect(burstsOmitted).toBe(2);
  });
});

describe('requests.followUps (#74)', () => {
  const base = FAR + 500_000;

  it('요청 상세와 같은 followUps 를 변경·재조회 쌍으로 모은다', () => {
    const save1 = rec('POST', '/api/todos', base);
    const save2 = rec('POST', '/api/todos', base + 5000);
    const records = [
      save1,
      rec('GET', '/api/todos', base + 50, { sameResponseAs: 1 }),
      rec('GET', '/api/user', base + 60),
      save2,
      rec('GET', '/api/todos', base + 5050, { sameResponseAs: 1 }),
      rec('GET', '/api/todos', base + 5900),
      rec('DELETE', '/api/todos/3', base + 7000),
      rec('GET', '/api/todos', base + 7100),
    ];
    const list = section(records).followUps;
    expect(list).toEqual([
      {
        mutation: 'POST /api/todos',
        mutationId: 'ep:POST /api/todos',
        refetched: 'GET /api/todos',
        refetchedId: 'ep:GET /api/todos',
        mutations: 2,
        count: 3,
        sameResponse: 2,
      },
      {
        mutation: 'POST /api/todos',
        mutationId: 'ep:POST /api/todos',
        refetched: 'GET /api/user',
        refetchedId: 'ep:GET /api/user',
        mutations: 1,
        count: 1,
        sameResponse: 0,
      },
      {
        mutation: 'DELETE /api/todos/:id',
        mutationId: 'ep:DELETE /api/todos/:id',
        refetched: 'GET /api/todos',
        refetchedId: 'ep:GET /api/todos',
        mutations: 1,
        count: 1,
        sameResponse: 0,
      },
    ]);
    // 패널(요청 상세)이 보여 주는 수와 같다
    const panel = [save1, save2].flatMap((m) => followUps(m, records)).filter((f) => f.endpoint === 'GET /api/todos');
    expect(panel.reduce((n, f) => n + f.count, 0)).toBe(3);
    expect(panel.reduce((n, f) => n + f.sameResponse, 0)).toBe(2);
  });

  it('두 저장의 1초 창에 함께 든 조회는 바로 앞 저장 하나에만 센다', () => {
    const at = base + 40_000;
    const save1 = rec('POST', '/api/todos', at); // 응답 at+10
    const save2 = rec('PUT', '/api/todos/1', at + 300); // 응답 at+310
    const between = rec('GET', '/api/todos', at + 200); // save1 몫
    const after = rec('GET', '/api/todos', at + 400, { sameResponseAs: between.id }); // 둘 다의 창이지만 save2 몫
    const records = [save1, between, save2, after];
    expect(section(records).followUps).toEqual([
      {
        mutation: 'PUT /api/todos/:id',
        mutationId: 'ep:PUT /api/todos/:id',
        refetched: 'GET /api/todos',
        refetchedId: 'ep:GET /api/todos',
        mutations: 1,
        count: 1,
        sameResponse: 1,
      },
      {
        mutation: 'POST /api/todos',
        mutationId: 'ep:POST /api/todos',
        refetched: 'GET /api/todos',
        refetchedId: 'ep:GET /api/todos',
        mutations: 1,
        count: 1,
        sameResponse: 0,
      },
    ]);
    // 요청 상세도 같다: 합이 조회 수(2)를 넘지 않는다
    expect(followUps(save1, records).map((f) => f.count)).toEqual([1]);
    expect(followUps(save2, records).map((f) => f.count)).toEqual([1]);
  });

  it('같은 응답은 같은 페이지 로드의 응답과 같은 것만 세고, 새로고침 전 기록은 보지 않는다', () => {
    const at = base + 60_000;
    const before = rec('GET', '/api/todos', at - 30_000, { load: 0, restored: true });
    const save = rec('POST', '/api/todos', at);
    const crossLoad = rec('GET', '/api/todos', at + 50, { sameResponseAs: before.id });
    const restoredSave = rec('POST', '/api/old', at - 20_000, { load: 0, restored: true });
    const restoredGet = rec('GET', '/api/old', at - 19_950, { load: 0, restored: true, sameResponseAs: before.id });
    const records = [before, restoredSave, restoredGet, save, crossLoad];
    expect(section(records).followUps).toEqual([
      {
        mutation: 'POST /api/todos',
        mutationId: 'ep:POST /api/todos',
        refetched: 'GET /api/todos',
        refetchedId: 'ep:GET /api/todos',
        mutations: 1,
        count: 1,
        sameResponse: 0,
      },
    ]);
    expect(followUps(restoredSave, records)).toEqual([]);
  });

  it('변경 요청 쪽 엔드포인트를 무시해도 ignored 로 표시하고 summary 는 짚지 않는다', () => {
    const at = base + 80_000;
    const save = rec('POST', '/api/track', at);
    const records = [save, rec('GET', '/api/todos', at + 50, { sameResponseAs: 1 })];
    const ignored = new Set(['POST /api/track']);
    const requests = section(records, ignored);
    expect(requests.followUps).toEqual([expect.objectContaining({ mutation: 'POST /api/track', ignored: true })]);
    expect(summaryOf(requests).topFindings.map((f) => f.kind)).not.toContain('refetch-after-mutation');
  });

  it('queryKey 와 polling·무시 여부를 싣는다', () => {
    const save = rec('POST', '/api/save', base + 20_000);
    const polls = [0, 10_000, 20_000].map((t) => rec('GET', '/api/poll', base + 20_050 + t));
    const keyed = rec('GET', '/api/list', base + 20_060);
    const records = [save, ...polls, keyed, rec('GET', '/api/ignored', base + 20_070)];
    const list = buildRequestSection(records, classifyRecords(records, new Set()), ignoreMatcher(new Set(['GET /api/ignored'])), (r) =>
      r === keyed ? { queryKey: '["list"]' } : undefined,
    ).followUps;
    expect(list).toEqual([
      expect.objectContaining({ refetched: 'GET /api/poll', periodic: true }),
      expect.objectContaining({ refetched: 'GET /api/list', queryKey: '["list"]' }),
      expect.objectContaining({ refetched: 'GET /api/ignored', ignored: true }),
    ]);
    expect(list[1]).not.toHaveProperty('periodic');
    expect(list[1]).not.toHaveProperty('ignored');
  });
});

describe('summary 의 몰림·변경 뒤 재조회 (#74)', () => {
  it('낭비 몰림과 같은 응답을 받은 변경 뒤 재조회를 medium 으로 고칠 것과 함께 짚는다', () => {
    const at = FAR + 700_000;
    const save = rec('POST', '/api/todos', at + 10_000);
    const records = [
      ...burstAt(performance.timeOrigin + 500, ['/api/boot']), // 진입 몰림은 짚지 않는다
      ...burstAt(at, ['/api/items/1', '/api/items/2']),
      save,
      rec('GET', '/api/todos', at + 10_050, { sameResponseAs: 1 }),
      rec('GET', '/api/user', at + 10_060), // 응답이 바뀌었으면 짚지 않는다
    ];
    const requests = section(records);
    // 같은 응답 재조회는 엔드포인트 행(high)으로도 짚힌다. 여기서는 새 종류만 본다.
    const findings = summaryOf(requests).topFindings.filter((f) => f.kind === 'request-burst' || f.kind === 'refetch-after-mutation');
    // 구체적인 재조회 finding 이 일반적인 몰림보다 먼저다
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'refetch-after-mutation',
        severity: 'medium',
        target: { id: 'ep:GET /api/todos', endpoint: 'GET /api/todos' },
        evidence: { mutations: 1, count: 1, sameResponse: 1 },
        savings: { requests: 1 },
        detail: 'requests.followUps[0]',
      }),
      expect.objectContaining({
        kind: 'request-burst',
        severity: 'medium',
        target: { id: 'ep:GET /api/items/:id', endpoint: 'GET /api/items/:id' },
        evidence: { count: 5, spanMs: 400, wasted: 0, endpoints: 1 },
        savings: { requests: 4 },
        detail: 'requests.bursts[0]',
      }),
    ]);
    expect(findings[1].fix).toContain('outside page entry');
    expect(findings[0].fix).toContain('After POST /api/todos, GET /api/todos');
    expect(requests.bursts[1].kind).toBe('entry');
  });

  it('몰림의 절감은 중복 finding 이 이미 센 요청을 빼고, 그 finding 을 relatedFindings 로 가리키며 뒤에 둔다', () => {
    const at = FAR + 750_000;
    const first = rec('GET', '/api/same', at);
    const records = [
      first,
      rec('GET', '/api/same', at + 100, { duplicateOf: first.id }),
      rec('GET', '/api/a', at + 200),
      rec('GET', '/api/b', at + 300),
      rec('GET', '/api/c', at + 400),
    ];
    const requests = section(records);
    expect(requests.bursts[0].overlaps).toEqual([{ detail: 'requests.endpoints[0]', requests: 1 }]);
    const findings = summaryOf(requests).topFindings;
    expect(findings.map((f) => f.kind)).toEqual(['duplicate', 'request-burst']);
    expect(findings[1]).toMatchObject({
      savings: { requests: 3 },
      evidence: { count: 5, counted: 1 },
      relatedFindings: ['requests.endpoints[0]'],
    });
  });

  it('몰림의 절반 이상을 다른 finding 이 이미 셌으면 몰림은 짚지 않고 그 finding 에 몰림을 단다', () => {
    const at = FAR + 760_000;
    const first = rec('GET', '/api/same', at);
    const records = [
      first,
      ...[100, 150, 200].map((d) => rec('GET', '/api/same', at + d, { duplicateOf: first.id })),
      rec('GET', '/api/other', at + 300),
    ];
    const findings = summaryOf(section(records)).topFindings;
    expect(findings.map((f) => f.kind)).toEqual(['duplicate']);
    expect(findings[0].relatedFindings).toEqual(['requests.bursts[0]']);
  });

  it('polling 과 겹치거나 무시한 엔드포인트로의 재조회는 같은 응답이어도 짚지 않는다', () => {
    const at = FAR + 800_000;
    const save = rec('POST', '/api/save', at);
    const polls = [0, 10_000, 20_000].map((t) => rec('GET', '/api/poll', at + 50 + t, { sameResponseAs: 1 }));
    const ignored = rec('GET', '/api/ignored', at + 60, { sameResponseAs: 1 });
    const kinds = summaryOf(section([save, ...polls, ignored], new Set(['GET /api/ignored']))).topFindings.map((f) => f.kind);
    expect(kinds).not.toContain('refetch-after-mutation');
  });
});

describe('보고서 (#74)', () => {
  it('buildReport 가 기록 저장소의 기록으로 bursts·followUps 를 싣는다', () => {
    const at = FAR + 900_000;
    const records = [...burstAt(at, ['/api/a']), rec('PATCH', '/api/a', at + 5000), rec('GET', '/api/a', at + 5050)];
    mergeRecords(records);
    const report = buildReport(false, at + 10_000);
    expect(report.requests.bursts).toEqual([expect.objectContaining({ kind: 'waste', count: 5 })]);
    expect(report.requests.followUps).toEqual([expect.objectContaining({ mutation: 'PATCH /api/a', refetched: 'GET /api/a' })]);
    expect(report.howToRead?.some((l) => l.startsWith('requests.bursts'))).toBe(true);
    expect(report.howToRead?.some((l) => l.startsWith('requests.followUps'))).toBe(true);
  });
});
