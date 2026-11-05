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
          { endpoint: 'GET /api/items/:id', count: 4 },
          { endpoint: 'GET /api/user', count: 1 },
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

  it('낭비로 센 요청 수를 싣고, 무시한 엔드포인트(패널·configure)의 반복은 타임라인처럼 세지 않는다', () => {
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
    ];
    expect(section(records).bursts[0]).toMatchObject({ count: 7, wasted: 3 });
    configure({ ignore: ['GET /api/code'] });
    const panelIgnore = new Set(['GET /api/panel']);
    // 무시한 반복 셋을 빼면 4건이라 몰림이 아니다. 타임라인도 같다.
    expect(section(records, panelIgnore).bursts).toEqual([]);
    const classes = classifyRecords(records, ignoreMatcher(panelIgnore));
    expect(analyzeBursts(records, (r) => classes.get(r.id) ?? 'ok')).toEqual([]);
    // 코드 무시만 있으면 6건, 무시한 반복은 낭비로 세지 않는다
    expect(section(records).bursts[0]).toMatchObject({ count: 6, wasted: 2 });
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
      { mutation: 'POST /api/todos', refetched: 'GET /api/todos', mutations: 2, count: 3, sameResponse: 2 },
      { mutation: 'POST /api/todos', refetched: 'GET /api/user', mutations: 1, count: 1, sameResponse: 0 },
      { mutation: 'DELETE /api/todos/:id', refetched: 'GET /api/todos', mutations: 1, count: 1, sameResponse: 0 },
    ]);
    // 패널(요청 상세)이 보여 주는 수와 같다
    const panel = [save1, save2].flatMap((m) => followUps(m, records)).filter((f) => f.endpoint === 'GET /api/todos');
    expect(panel.reduce((n, f) => n + f.count, 0)).toBe(3);
    expect(panel.reduce((n, f) => n + f.sameResponse, 0)).toBe(2);
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
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'request-burst',
        severity: 'medium',
        target: { endpoint: 'GET /api/items/:id' },
        evidence: { count: 5, spanMs: 400, wasted: 0, endpoints: 1 },
        savings: { requests: 4 },
        detail: 'requests.bursts[0]',
      }),
      expect.objectContaining({
        kind: 'refetch-after-mutation',
        severity: 'medium',
        target: { endpoint: 'GET /api/todos' },
        evidence: { mutations: 1, count: 1, sameResponse: 1 },
        savings: { requests: 1 },
        detail: 'requests.followUps[0]',
      }),
    ]);
    expect(findings[0].fix).toContain('outside page entry');
    expect(findings[1].fix).toContain('After POST /api/todos, GET /api/todos');
    expect(requests.bursts[1].kind).toBe('entry');
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
