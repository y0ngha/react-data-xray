import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, mockFetch } from '../../testing/fetchMock.js';
import { renderWithActions } from '../../testing/withActions.js';
import { RequestsTab } from '../../ui/panels/requests/RequestsTab.js';
import { IGNORE_KEY, ignoreMatcher } from '../../shared/ignoredEndpoints.js';
import { useIgnoredEndpoints } from '../../ui/hooks/useIgnoredEndpoints.js';
import { useRequestAnalysis } from '../../ui/hooks/useRequestAnalysis.js';
import { configure, configVersion, effectiveConfig, isConfigIgnored, subscribeConfig } from '../config.js';
import { flushIndex } from '../inspect/derivedMatch.js';
import { auditQueryCache, findQueryClients } from '../reactQuery/cacheAudit.js';
import { buildReport } from '../report/buildReport.js';
import { compare, toComparable, type ComparableReport } from '../report/compare.js';
import { findBursts } from '../requests/bursts.js';
import { classifyRecords } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { paramKeyOf, requestKeyOf } from '../requests/requestKey.js';
import { createRecord, finishRecord, getDroppedCount, getRecords, mergeRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { flushQueue } from '../scheduler/idleQueue.js';

// #78: 판정 기준·무시 목록을 코드(configure)에서 정한다.
afterEach(() => {
  vi.restoreAllMocks();
});

/** 요청 하나를 시작하고(헤더를 기록한 뒤) 끝낸다. 판정은 유휴 큐에서 하므로 큐를 비운다. */
const send = (url: string, headers?: Record<string, string>): RequestRecord => {
  const record = createRecord('fetch', 'GET', url);
  record.requestHeaders = headers;
  finishRecord(record, 200);
  flushQueue();
  return record;
};

describe('configure 값 검사 (#78)', () => {
  it('정하지 않으면 지금까지의 기본값이다', () => {
    expect(effectiveConfig()).toEqual({
      ignore: { code: [], panel: [] },
      keyHeaders: [],
      dedupeWindowMs: 2000,
      burst: { windowMs: 500, count: 5 },
      nPlusOne: { windowMs: 1000, count: 5 },
      maxRecords: 200,
      reportPath: '/__rdx/report',
    });
  });

  it('맞지 않는 값은 경고하고 기본값을 쓰며, 맞는 값은 그대로 쓴다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configure({
      ignore: ['/health', 'GET /items/5', /\/metrics/g, 3 as unknown as string],
      keyHeaders: ['X-Tenant', 'bad header', 'x-tenant'],
      dedupeWindowMs: -1,
      burst: { windowMs: 0, count: 3 },
      maxRecords: 1.5,
      reportPath: 'no-slash',
    });
    expect(effectiveConfig()).toEqual({
      // 경로만 쓴 것과 문자열이 아닌 것은 빠지고, 저장된 무시처럼 ID 는 :id 로 묶는다.
      ignore: { code: ['/\\/metrics/', 'GET /items/:id'], panel: [] },
      keyHeaders: ['x-tenant'],
      dedupeWindowMs: 2000,
      burst: { windowMs: 500, count: 3 },
      nPlusOne: { windowMs: 1000, count: 5 },
      maxRecords: 200,
      reportPath: '/__rdx/report',
    });
    const messages = warn.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes("'/health'") || m.includes('"/health"'))).toBe(true);
    expect(messages.some((m) => m.includes('dedupeWindowMs'))).toBe(true);
    expect(messages.some((m) => m.includes('burst.windowMs'))).toBe(true);
    expect(messages.some((m) => m.includes('maxRecords'))).toBe(true);
    expect(messages.some((m) => m.includes('reportPath'))).toBe(true);
    expect(messages.some((m) => m.includes('"bad header"'))).toBe(true);
  });

  it('배열·객체가 아닌 값도 경고만 하고 기본값을 쓴다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configure({
      ignore: 'GET /a' as unknown as string[],
      keyHeaders: 'x-a' as unknown as string[],
      burst: 5 as unknown as { count: number },
    });
    configure(null as unknown as Record<string, never>);
    expect(effectiveConfig().ignore).toEqual({ code: [], panel: [] });
    expect(effectiveConfig().burst).toEqual({ windowMs: 500, count: 5 });
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('같은 값으로 여러 번 불러도 같고, 부를 때마다 앞 설정을 통째로 바꾼다', () => {
    configure({ dedupeWindowMs: 1000, keyHeaders: ['x-a'] });
    const once = effectiveConfig();
    configure({ dedupeWindowMs: 1000, keyHeaders: ['x-a'] });
    expect(effectiveConfig()).toEqual(once);
    configure({ maxRecords: 50 });
    expect(effectiveConfig()).toMatchObject({ dedupeWindowMs: 2000, keyHeaders: [], maxRecords: 50 });
  });
});

describe('configure 의 판정 기준 (#78)', () => {
  it('ignore 의 이름·정규식은 패널의 무시와 합쳐 낭비로 세지 않는다(g 플래그여도 매번 맞는다)', () => {
    configure({ ignore: ['GET /api/health', /^GET \/api\/metrics/g] });
    const records = [send('/api/health'), send('/api/health'), send('/api/metrics'), send('/api/metrics'), send('/api/metrics')];
    records.push(send('/api/users'), send('/api/users'));
    const classes = classifyRecords(records, new Set(['GET /api/users']));
    expect(
      records
        .slice(1)
        .filter((r) => r.duplicateOf)
        .map((r) => classes.get(r.id)),
    ).toEqual(Array(4).fill('ignored'));
    expect(isConfigIgnored('GET /api/metrics')).toBe(true);
    expect(isConfigIgnored('GET /api/users')).toBe(false);
  });

  it('keyHeaders 로 정한 헤더만 다른 요청은 다른 요청이라 중복이 아니다', () => {
    const a = send('/api/me', { 'x-tenant': 'a', 'x-trace': '1' });
    const b = send('/api/me', { 'x-tenant': 'b', 'x-trace': '2' });
    expect(b.duplicateOf).toBe(a.id); // 정하기 전에는 헤더를 보지 않는다
    configure({ keyHeaders: ['X-Tenant'] });
    const c = send('/api/me', { 'x-tenant': 'a', 'x-trace': '3' });
    const d = send('/api/me', { 'x-tenant': 'b', 'x-trace': '4' });
    const e = send('/api/me', { 'x-tenant': 'b', 'x-trace': '5' });
    expect(d.duplicateOf).toBeUndefined();
    expect(e.duplicateOf).toBe(d.id);
    expect(requestKeyOf(c)).not.toBe(requestKeyOf(d));
    // 헤더가 없는 요청의 키는 정하기 전과 같다.
    expect(requestKeyOf({ method: 'GET', url: '/x', requestHeaders: { 'x-trace': '1' } })).toBe('GET http://localhost:3000/x ');
  });

  it('dedupeWindowMs 를 넘긴 다시 보냄은 중복이 아니다', () => {
    configure({ dedupeWindowMs: 0 });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    send('/api/a');
    now.mockReturnValue(1001);
    expect(send('/api/a').duplicateOf).toBeUndefined();
    configure({ dedupeWindowMs: 5000 });
    now.mockReturnValue(4000);
    expect(send('/api/a').duplicateOf).toBeDefined();
  });

  it('burst 의 창 길이와 건수로 몰림을 찾는다', () => {
    const starts = [0, 100, 200, 900];
    expect(findBursts(starts)).toEqual([]);
    configure({ burst: { count: 3 } });
    expect(findBursts(starts)).toEqual([{ from: 0, to: 200, count: 3 }]);
    configure({ burst: { windowMs: 1000, count: 4 } });
    expect(findBursts(starts)).toEqual([{ from: 0, to: 900, count: 4 }]);
  });

  it('maxRecords 를 넘으면 오래된 요청부터 버리고 버린 수를 센다', () => {
    configure({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) send(`/api/${i}`);
    expect(getRecords().map((r) => r.url)).toEqual(['/api/2', '/api/3', '/api/4']);
    expect(getDroppedCount()).toBe(2);
  });
});

describe('보고서와 비교 (#78)', () => {
  it('보고서에 적용된 설정을 남기고, 코드로 무시한 엔드포인트는 ignored 다', () => {
    configure({ ignore: ['GET /api/health'], keyHeaders: ['x-tenant'] });
    send('/api/health');
    const report = buildReport(false);
    expect(report.config).toEqual(effectiveConfig());
    expect(report.requests.endpoints.find((e) => e.endpoint === 'GET /api/health')?.ignored).toBe(true);
  });

  it('보고서의 config.ignore 는 코드와 패널의 무시를 나눠 담는다', () => {
    configure({ ignore: [/health/, 'GET /api/b'] });
    localStorage.setItem(IGNORE_KEY, JSON.stringify(['GET /api/users']));
    expect(buildReport(false).config.ignore).toEqual({ code: ['/health/', 'GET /api/b'], panel: ['GET /api/users'] });
  });

  it('판정 기준이 다른 두 보고서를 비교하면 그 항목만 경고한다', () => {
    const configWarnings = (a: ComparableReport, b: ComparableReport) =>
      compare(a, b).warnings.filter((w) => w.startsWith('detection config'));
    const before = toComparable(buildReport(false));
    configure({ dedupeWindowMs: 1000, ignore: [/health/], reportPath: '/app/__rdx/report', maxRecords: 100 });
    localStorage.setItem(IGNORE_KEY, JSON.stringify(['GET /api/users']));
    const after = toComparable(buildReport(false));
    // reportPath 는 보내는 곳일 뿐이고, maxRecords 는 버린 요청이 없으면 결과를 바꾸지 않는다.
    expect(configWarnings(before, after)).toEqual([
      'detection config differs: dedupeWindowMs 2000 / 1000',
      'detection config differs: ignore (code) [] / ["/health/"]',
      'detection config differs: ignore (panel) [] / ["GET /api/users"]',
    ]);
    expect(configWarnings({ ...before, requests: { ...before.requests, dropped: 3 } }, after)).toContain(
      'detection config differs: maxRecords 200 / 100',
    );
    expect(configWarnings(before, before)).toEqual([]);
    // 무시 목록은 순서와 무관하다.
    const reordered = (r: ComparableReport, code: string[]): ComparableReport => ({
      ...r,
      config: { ...r.config!, ignore: { code, panel: [] } },
    });
    expect(configWarnings(reordered(before, ['a', 'b']), reordered(before, ['b', 'a']))).toEqual([]);
    // 설정을 남기기 전에 저장한 스냅샷과는 비교하지 않는다.
    expect(configWarnings({ ...before, config: undefined }, after)).toEqual([]);
  });
});

describe('리뷰 반영 (#78)', () => {
  it('maxRecords 는 5000 을 넘으면 경고하고 5000 으로 둔다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configure({ maxRecords: 100_000 });
    expect(effectiveConfig().maxRecords).toBe(5000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxRecords 100000 is above the limit'));
  });

  it('되살린 기록은 configure 전에 기본 상한으로 자르지 않고, 그때의 설정으로 자르며 버린 수로 세지 않는다', () => {
    const restored = Array.from({ length: 250 }, (_, i): RequestRecord => ({
      ...createRecord('fetch', 'GET', `/api/old/${i}`),
      id: 10_000 + i,
      restored: true,
    }));
    mergeRecords(restored);
    expect(getRecords()).toHaveLength(250);
    configure({ maxRecords: 300 });
    flushQueue();
    expect(getRecords()).toHaveLength(250);
    configure({ maxRecords: 240 });
    send('/api/new');
    expect(getRecords()).toHaveLength(240);
    expect(getRecords().at(-1)?.url).toBe('/api/new');
    expect(getDroppedCount()).toBe(0);
  });

  it('두 사본이 있어도 어느 사본의 configure 든 같은 설정에 닿는다', async () => {
    vi.resetModules();
    const other = await import('../config.js');
    expect(other.configure).not.toBe(configure);
    other.configure({ dedupeWindowMs: 1234 });
    expect(effectiveConfig().dedupeWindowMs).toBe(1234);
    configure({ dedupeWindowMs: 999 });
    expect(other.effectiveConfig().dedupeWindowMs).toBe(999);
  });

  it('configure 하면 구독자에게 알리고 번호가 오른다', () => {
    const listener = vi.fn<() => void>();
    const off = subscribeConfig(listener);
    const before = configVersion();
    configure({ dedupeWindowMs: 10 });
    expect(configVersion()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    configure({});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keyHeaders 만 다른 요청은 캐시키 점검에서 키에 빠진 파라미터·중복 캐시가 아니다', async () => {
    configure({ keyHeaders: ['x-tenant'] });
    // 응답이 같으면 structural sharing 이 앞 객체를 그대로 두어 출처가 앞 요청으로 남는다. 테넌트마다 다르게 답한다.
    mockFetch.mockImplementation(async (input, init) =>
      jsonResponse({ page: `${String(input)} ${new Headers(init?.headers).get('x-tenant') ?? ''}`, size: 20, total: 100 }),
    );
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <p>app</p>
      </QueryClientProvider>,
    );
    findQueryClients();
    const me =
      (tenant: string, url = '/api/me') =>
      () =>
        fetch(url, { headers: { 'x-tenant': tenant } }).then((r) => r.json());
    // 같은 키를 다른 테넌트로: 파라미터가 빠진 것이 아니다.
    await client.fetchQuery({ queryKey: ['me'], queryFn: me('a') });
    await client.fetchQuery({ queryKey: ['me'], queryFn: me('b') });
    // 테넌트별 키: 같은 요청을 다른 키로 캐시한 것이 아니다(헤더가 다르다).
    await client.fetchQuery({ queryKey: ['team', 'a'], queryFn: me('a', '/api/team') });
    await client.fetchQuery({ queryKey: ['team', 'b'], queryFn: me('b', '/api/team') });
    flushIndex();
    flushQueue();
    const kinds = auditQueryCache(() => 'ok', getRecords()).map((f) => f.kind);
    expect(kinds).not.toContain('key-missing-param');
    expect(kinds).not.toContain('duplicate-cache');
    expect(paramKeyOf({ method: 'GET', url: '/a', requestHeaders: { 'x-tenant': 'a' } })).toBe(
      paramKeyOf({ method: 'GET', url: '/a', requestHeaders: { 'x-tenant': 'b' } }),
    );
  });
});

describe('패널의 무시 표시 (#78)', () => {
  it('코드로 무시한 엔드포인트는 Ignore 버튼 대신 풀 수 없다는 표시를 보인다', () => {
    configure({ ignore: ['GET /api/health'] });
    const records = [send('/api/health'), send('/api/users')];
    const stats = getEndpointStats(records, classifyRecords(records, new Set()));
    renderWithActions(
      <RequestsTab records={records} stats={stats} ignored={new Set()} onToggleIgnore={vi.fn<(endpoint: string) => void>()} />,
    );
    expect(screen.getByText('Ignored (config)')).toBeTruthy();
    expect(screen.getAllByText('Ignore')).toHaveLength(1);
  });

  it('configure 를 다시 부르면 패널이 다시 분류해 요청 탭 표시와 분류가 같다', () => {
    const records = [send('/api/health'), send('/api/health')];
    const { result } = renderHook(() => {
      const { ignored } = useIgnoredEndpoints();
      return { ignored, analysis: useRequestAnalysis(ignored) };
    });
    expect(result.current.analysis.classOf(records[1])).toBe('duplicate');
    act(() => configure({ ignore: ['GET /api/health'] }));
    expect(result.current.analysis.classOf(records[1])).toBe('ignored');
    expect(result.current.ignored.sourceOf('GET /api/health')).toBe('code');
    act(() => configure({}));
    expect(result.current.analysis.classOf(records[1])).toBe('duplicate');
    expect(result.current.ignored.sourceOf('GET /api/health')).toBeUndefined();
  });

  it('코드로도 무시한 패널 키는 "보이지 않는 무시" 목록에 지울 수 있게 두지 않는다', () => {
    configure({ ignore: [/^GET \/gone/] });
    renderWithActions(
      <RequestsTab
        records={[]}
        stats={[]}
        ignored={ignoreMatcher(new Set(['GET /gone/a', 'GET /old']))}
        onToggleIgnore={vi.fn<(endpoint: string) => void>()}
      />,
    );
    expect(screen.getByText('GET /old')).toBeTruthy();
    expect(screen.queryByText('GET /gone/a')).toBeNull();
  });
});
