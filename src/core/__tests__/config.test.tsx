import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithActions } from '../../testing/withActions.js';
import { RequestsTab } from '../../ui/panels/requests/RequestsTab.js';
import { configure, effectiveConfig, isConfigIgnored } from '../config.js';
import { buildReport } from '../report/buildReport.js';
import { compare, toComparable } from '../report/compare.js';
import { findBursts } from '../requests/bursts.js';
import { classifyRecords } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { requestKeyOf } from '../requests/requestKey.js';
import { createRecord, finishRecord, getDroppedCount, getRecords } from '../requests/store.js';
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
      ignore: [],
      keyHeaders: [],
      dedupeWindowMs: 2000,
      burst: { windowMs: 500, count: 5 },
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
      ignore: ['GET /items/:id', '/\\/metrics/'],
      keyHeaders: ['x-tenant'],
      dedupeWindowMs: 2000,
      burst: { windowMs: 500, count: 3 },
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
    expect(effectiveConfig().ignore).toEqual([]);
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

  it('설정이 다른 두 보고서를 비교하면 다른 항목을 경고한다', () => {
    const before = toComparable(buildReport(false));
    configure({ dedupeWindowMs: 1000, ignore: [/health/] });
    const after = toComparable(buildReport(false));
    const { warnings } = compare(before, after);
    expect(warnings).toContain('detection config differs: ignore [] / ["/health/"]');
    expect(warnings).toContain('detection config differs: dedupeWindowMs 2000 / 1000');
    const configWarnings = (a: typeof before, b: typeof before) => compare(a, b).warnings.filter((w) => w.startsWith('detection config'));
    expect(configWarnings(before, before)).toEqual([]);
    // 설정을 남기기 전에 저장한 스냅샷과는 비교하지 않는다.
    expect(configWarnings({ ...before, config: undefined }, after)).toEqual([]);
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
});
