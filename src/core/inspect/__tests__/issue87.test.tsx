import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithActions } from '../../../testing/withActions.js';
import { RequestsTab } from '../../../ui/panels/requests/RequestsTab.js';
import { IGNORE_KEY } from '../../../shared/ignoredEndpoints.js';
import { configure } from '../../config.js';
import { buildReport } from '../../report/buildReport.js';
import { classifyRecords } from '../../requests/classify.js';
import { getEndpointStats } from '../../requests/endpointStats.js';
import { createRecord, finishRecord, getRecords, registerBody } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { findConsumers } from '../consumers.js';
import { installUnusedCheck, UNUSED_SETTLE_MS } from '../unused.js';

type Item = { id: number; title: string };

const Row = ({ item }: { item: Item }) => <li>{item.title}</li>;
const List = ({ items }: { items: readonly Item[] }) => (
  <ul>
    {items.map((item) => (
      <Row key={item.id} item={item} />
    ))}
  </ul>
);

const received = (url: string, body: unknown, { method = 'GET', status = 200 } = {}): RequestRecord => {
  const record = createRecord('fetch', method, url);
  finishRecord(record, status);
  registerBody(record, body);
  return record;
};

const items = (): Item[] => [
  { id: 101, title: 'CPU warning' },
  { id: 102, title: 'Memory warning' },
];

/** 판정 예약(구독자) → 기다림 → 판정까지. 큐는 배경 구동 대신 직접 비운다. */
const settle = (): void => {
  flushQueue();
  vi.advanceTimersByTime(UNUSED_SETTLE_MS);
  flushQueue();
};

beforeEach(() => {
  // 판정 예약(setTimeout)만 가짜로 돌린다. performance.now 는 그대로 둬야 큐가 시간으로 끊는다.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  installUnusedCheck();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('쓰지 않는 응답 (#87)', () => {
  it('unused_marked: 응답 몇 초 뒤에도 그 응답을 들고 있는 컴포넌트가 없으면 unused 로 둔다', () => {
    const record = received('/api/prefetch', { items: items() });
    render(<p>nothing</p>);
    flushQueue();
    expect(record.unused).toBeUndefined();
    vi.advanceTimersByTime(UNUSED_SETTLE_MS - 1);
    flushQueue();
    expect(record.unused).toBeUndefined(); // 렌더가 끝날 시간을 기다린다
    vi.advanceTimersByTime(1);
    flushQueue();
    expect(record.unused).toBe(true);
  });

  it('used_exact: 응답 객체를 그대로 props 로 받는 컴포넌트가 있으면 쓰는 응답이다', () => {
    const body = { items: items() };
    const record = received('/api/list', body);
    render(<List items={body.items} />);
    settle();
    expect(record.unused).toBe(false);
  });

  it('used_derived: 필드를 덧붙여 새로 만든 객체(가공)라도 필드 값이 겹치면 쓰는 응답이다', () => {
    const body = { items: items() };
    const record = received('/api/derived', body);
    const mapped = body.items.map(({ id, title }) => ({ id, title, label: `#${id}` }));
    render(<List items={mapped} />);
    settle();
    expect(record.unused).toBe(false);
  });

  it('used_previous_response: 같은 요청의 이전 응답 객체를 들고 있으면(React Query 의 structural sharing) 쓰는 응답이다', () => {
    const first = { items: items() };
    received('/api/shared?page=1', first);
    render(<List items={first.items} />);
    const second = received('/api/shared?page=1', { items: [{ id: 103, title: 'other' }] });
    settle();
    expect(second.unused).toBe(false);
  });

  it('detail_derived: 요청 상세의 소비자 찾기도 참조로 못 찾으면 파생으로 찾아(판정과 같은 기준) 그렇다고 표시한다', () => {
    const body = { items: items() };
    const record = received('/api/detail', body);
    render(<List items={body.items.map(({ id, title }) => ({ id, title }))} />);
    flushQueue();
    expect(findConsumers(record, () => false)).toEqual([]);
    const derived = findConsumers(record, () => false, 1000, { derived: true });
    expect(derived.map((c) => [c.name, c.match])).toContainEqual(['Row', 'derived']);
  });

  it('own_ui_ignored: rdx 패널이 들고 있는 응답은 쓰는 것으로 보지 않는다', () => {
    const body = { items: items() };
    const record = received('/api/panel-only', body);
    render(
      <div data-rdx-root="">
        <List items={body.items} />
      </div>,
    );
    settle();
    expect(record.unused).toBe(true);
  });

  it('skipped: 변경 요청, 실패, 빈 본문, JSON 이 아닌 응답, 무시한 엔드포인트는 판정하지 않는다', () => {
    localStorage.setItem(IGNORE_KEY, JSON.stringify(['GET /api/ignored']));
    configure({ ignore: [/config-ignored/] });
    const skipped = [
      received('/api/save', { ok: true, id: 12 }, { method: 'POST' }),
      received('/api/remove', { ok: true, id: 12 }, { method: 'DELETE' }),
      received('/api/failed', { error: 'boom' }, { status: 500 }),
      received('/api/empty-list', []),
      received('/api/empty-object', {}),
      received('/api/ignored', { items: items() }),
      received('/api/config-ignored', { items: items() }),
    ];
    const text = createRecord('fetch', 'GET', '/api/text');
    finishRecord(text, 200);
    render(<p>nothing</p>);
    settle();
    expect([...skipped, text].filter((r) => r.unused !== undefined).map((r) => r.url)).toEqual([]);
  });

  it('judged_once: 한 번 정한 판정은 다시 하지 않는다(나중에 그려도 그대로)', () => {
    const body = { items: items() };
    const record = received('/api/once', body);
    render(<p>nothing</p>);
    settle();
    expect(record.unused).toBe(true);
    render(<List items={body.items} />);
    received('/api/other', { items: [{ id: 300, title: 'x' }] }); // 기록이 바뀌어 구독자가 다시 불려도
    settle();
    expect(record.unused).toBe(true);
  });

  it('report: endpoints[].unused 와 unusedExamples, summary 의 unused-response(medium) 로 싣는다', () => {
    received('/api/unused?x=1', { items: items() });
    const body = { items: [{ id: 201, title: 'kept' }] };
    received('/api/used', body);
    render(<List items={body.items} />);
    settle();
    const report = buildReport(false);
    const unused = report.requests.endpoints.find((e) => e.endpoint === 'GET /api/unused');
    expect(unused).toMatchObject({ unused: 1, unusedExamples: ['/api/unused?x=1'] });
    expect(report.requests.endpoints.find((e) => e.endpoint === 'GET /api/used')).not.toHaveProperty('unused');
    const finding = report.summary.topFindings.find((f) => f.kind === 'unused-response');
    expect(finding).toMatchObject({ severity: 'medium', target: { endpoint: 'GET /api/unused' }, evidence: { unused: 1 } });
    expect(report.summary.badge.issues).toBe(0); // 배지는 세지 않는다(확인 필요)
    expect(report.howToRead?.some((line) => line.startsWith('unused is'))).toBe(true);
  });

  it('network_tab: 요청 행에 unused 배지, 엔드포인트 줄에 unused 수, Unused 로 그것만 거른다', () => {
    received('/api/unused', { items: items() });
    const body = { items: [{ id: 201, title: 'kept' }] };
    received('/api/used', body);
    render(<List items={body.items} />);
    settle();
    const records = getRecords();
    const stats = getEndpointStats(records, classifyRecords(records, new Set()));
    expect(stats.find((s) => s.endpoint === 'GET /api/unused')?.unused).toBe(1);
    renderWithActions(<RequestsTab records={records} stats={stats} ignored={new Set()} onToggleIgnore={vi.fn<(e: string) => void>()} />);
    expect(screen.getByText('unused: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unused' }));
    expect(screen.queryByText('GET /api/used')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All requests' }));
    expect(screen.getAllByText('unused')).toHaveLength(1);
    expect(screen.getByText(/GET \/api\/unused/)).toBeTruthy();
    expect(screen.queryByText(/GET \/api\/used/)).toBeNull();
  });
});

describe('쓰지 않는 응답 판정의 비용 (#87)', () => {
  // 행 2,000개 × (Cell + li): 4,000 fiber 넘는 화면. 소비자가 없어 참조·파생 두 번을 끝까지 훑는 최악의 경우다.
  const ROWS = 2000;
  const Cell = ({ value }: { value: { id: number; name: string; meta: { owner: string } } }) => <li>{value.name}</li>;

  const renderRows = (): RequestRecord => {
    const rows = Array.from({ length: ROWS }, (_, i) => ({ id: 10_000 + i, name: `row ${i}`, meta: { owner: `owner ${i}` } }));
    render(
      <ul>
        {rows.map((r) => (
          <Cell key={r.id} value={{ ...r, meta: { ...r.meta } }} />
        ))}
      </ul>,
    );
    const record = received('/api/never-rendered', { items: Array.from({ length: 500 }, (_, i) => ({ id: 90_000 + i, code: `c-${i}` })) });
    flushQueue(); // 출처 등록과 판정 예약
    vi.advanceTimersByTime(UNUSED_SETTLE_MS);
    return record;
  };

  /** 배경 구동이 하듯 4ms 조각을 되풀이하며 조각마다 걸린 시간을 잰다. */
  const runSlices = (): number[] => {
    const slices: number[] = [];
    while (isQueuePending() && slices.length < 100_000) {
      const started = performance.now();
      flushQueue(4);
      slices.push(performance.now() - started);
    }
    return slices;
  };

  it('chunked: 큰 트리도 조각마다 큐 예산(4ms) + step 하나(1ms) 안에서 끊어 훑고, 끝까지 판정한다', () => {
    const record = renderRows();
    // 벽시계는 coverage·병렬 실행에서 몇 배씩 흔들려 예산을 지켰는지 가를 수 없다. 시계를 부를 때마다 조금씩 가는 가상 시계로
    // "시간을 보며 끊는가"만 본다. 한 번에 다 훑는 코드(시계를 보지 않음)는 조각 하나로 끝나 실패한다.
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.002));
    try {
      const slices = runSlices();
      expect(record.unused).toBe(true);
      expect(slices.length).toBeGreaterThan(3);
      expect(Math.max(...slices)).toBeLessThan(5.1);
    } finally {
      clock.mockRestore();
    }
  });

  it('cost: 실제 시간을 재 남긴다(판정 하나의 유휴 시간과 조각 수)', () => {
    const record = renderRows();
    const slices = runSlices();
    const sorted = [...slices].sort((a, b) => a - b);
    const total = slices.reduce((n, t) => n + t, 0);
    console.info(
      `[#87] ${ROWS * 2}+ fibers: ${slices.length} slices, total ${total.toFixed(1)}ms, median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms, max ${sorted.at(-1)!.toFixed(2)}ms`,
    );
    expect(record.unused).toBe(true);
    expect(slices.length).toBeGreaterThan(1);
  });
});
