import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithActions } from '../../../testing/withActions.js';
import { RequestsTab } from '../../../ui/panels/requests/RequestsTab.js';
import { IGNORE_KEY } from '../../../shared/ignoredEndpoints.js';
import { configure } from '../../config.js';
import { nextCommitSeq } from '../../render/commitCauses.js';
import { buildReport } from '../../report/buildReport.js';
import { classifyRecords } from '../../requests/classify.js';
import { getEndpointStats } from '../../requests/endpointStats.js';
import { createRecord, finishRecord, getRecords, registerBody } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { getFiber } from '../../fiber/tree.js';
import { findConsumers } from '../consumers.js';
import { createFiberHolds } from '../holders.js';
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

  it('empty_nested: 키만 있고 값이 모두 빈 배열·객체인 응답은 판정하지 않고, 원시값이 하나라도 있으면 판정한다 (#123)', () => {
    const empty = [received('/api/disabled-models', { disabledModels: [] }), received('/api/nested-empty', { a: {}, b: [], c: { d: [] } })];
    const judged = [received('/api/one', { a: [1] }), received('/api/zero', { total: 0 }), received('/api/nil', { a: [null] })];
    render(<p>nothing</p>);
    settle();
    expect(empty.map((r) => r.unused)).toEqual([undefined, undefined]);
    expect(judged.map((r) => r.unused)).toEqual([true, true, true]);
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

  it('derived_any_origin: 가공한 객체가 다른 응답과 더 많이 겹쳐도, 이 요청의 응답과도 기준 이상 겹치면 쓰는 응답이다', () => {
    const mine = received('/api/summary', { rows: [{ id: 501, title: 'Alpha' }] });
    received('/api/detail-501', { row: { id: 501, title: 'Alpha', code: 'X-501' } });
    render(<List items={[{ id: 501, title: 'Alpha', code: 'X-501' } as Item]} />);
    settle();
    expect(mine.unused).toBe(false);
  });

  it('other_requests_no_cap: 다른 요청의 응답 객체를 많이 들고 있어도 이 요청의 객체까지 찾는다', () => {
    const others = Array.from({ length: 15 }, (_, i) => received(`/api/other-${i}`, { item: { id: 700 + i } }).body as { item: object });
    const body = { item: { id: 900, title: 'mine' } };
    const mine = received('/api/mine', body);
    const Holder = ({ list }: { list: readonly object[] }) => <p>holder {list.length}</p>;
    render(<Holder list={[...others.map((o) => o.item), body.item]} />);
    settle();
    expect(mine.unused).toBe(false);
  });

  it('batch: 함께 기다림이 끝난 응답 30건을 트리 한 번으로 함께 판정한다', () => {
    const bodies = Array.from({ length: 30 }, (_, i) => ({ items: [{ id: 1000 + i, title: `item ${i}` }] }));
    const records = bodies.map((body, i) => received(`/api/burst-${i}`, body));
    render(<List items={bodies[7].items} />);
    settle();
    expect(records.map((r) => r.unused)).toEqual(records.map((_, i) => i !== 7));
  });

  it('no_known_root: 기억한 React 루트가 없으면 판정하지 않는다(문서 전체를 훑지 않는다)', () => {
    const record = received('/api/no-root', { items: items() });
    const { container } = render(<p>nothing</p>);
    container.remove();
    const scan = vi.spyOn(document, 'querySelectorAll');
    settle();
    expect(record.unused).toBeUndefined();
    expect(scan).not.toHaveBeenCalledWith('*');
    scan.mockRestore();
  });

  it('unstable_tree: 훑는 사이 매번 commit 이 끼면 unused 로 정하지 않고 판정을 포기한다', () => {
    const record = received('/api/unstable', { items: items() });
    const ticking = {
      get seq() {
        return nextCommitSeq();
      },
    };
    const Ticker = ({ value }: { value: object }) => <p>tick {typeof value}</p>;
    render(<Ticker value={ticking} />);
    settle();
    expect(record.unused).toBeUndefined();
  });

  it('stale_found: 훑는 사이 commit 으로 사라진 컴포넌트에서 찾았으면 쓰는 것으로 보지 않고 다시 훑어 판정한다', () => {
    const body = { items: items() };
    const record = received('/api/stale', body);
    // 아무도 쓰지 않는 응답이 하나 더 있어야 List 를 찾은 뒤에도 Ticker 까지 훑는다
    const other = received('/api/stale-other', { items: [{ id: 990, title: 'nobody' }] });
    const control = { hide: (): void => {} };
    let fired = false;
    const trigger = {
      get once() {
        if (!fired) {
          fired = true;
          flushSync(control.hide); // 앞에서 찾은 List 를 지우는 commit
        }
        return 1;
      },
    };
    const Ticker = ({ value }: { value: object }) => <p>tick {typeof value}</p>;
    const Page = () => {
      const [shown, setShown] = useState(true);
      useEffect(() => {
        control.hide = () => setShown(false);
      });
      return (
        <div>
          {shown && <List items={body.items} />}
          <Ticker value={trigger} />
        </div>
      );
    };
    render(<Page />);
    settle();
    expect(fired).toBe(true);
    expect([record.unused, other.unused]).toEqual([true, true]);
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

  const renderRows = (responses = 1): RequestRecord[] => {
    const rows = Array.from({ length: ROWS }, (_, i) => ({ id: 10_000 + i, name: `row ${i}`, meta: { owner: `owner ${i}` } }));
    render(
      <ul>
        {rows.map((r) => (
          <Cell key={r.id} value={{ ...r, meta: { ...r.meta } }} />
        ))}
      </ul>,
    );
    const records = Array.from({ length: responses }, (__, n) =>
      received(`/api/never-rendered-${n}`, {
        items: Array.from({ length: 500 }, (_, i) => ({ id: 90_000 + n * 1000 + i, code: `c-${n}-${i}` })),
      }),
    );
    flushQueue(); // 출처 등록과 판정 예약
    vi.advanceTimersByTime(UNUSED_SETTLE_MS);
    return records;
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
    const [record] = renderRows();
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

  it('fiber_yields: 큰 목록을 든 fiber 하나도 객체 32개마다, 파생 후보마다 멈춰 한 조각을 넘지 않는다', () => {
    const big = Array.from({ length: 100 }, (_, i) => Array.from({ length: 100 }, (__, j) => ({ id: i * 100 + j })));
    const Big = ({ rows }: { rows: object[][] }) => <p>big {rows.length}</p>;
    render(<Big rows={big} />);
    const fiber = getFiber(screen.getByText('big 100'))!.return!;
    const count = (work: Generator<void, unknown, void>): number => {
      let yields = 0;
      while (!work.next().done) yields++;
      return yields;
    };
    // props → rows → 100 줄 → 줄마다 100 객체(깊이 3)
    expect(count(createFiberHolds('exact')(fiber, new Set(['x'])))).toBeGreaterThanOrEqual(10_000 / 32);
    expect(count(createFiberHolds('derived')(fiber, new Set(['x'])))).toBeGreaterThanOrEqual(30); // 값 하나에서 후보 30개
  });

  /** 조각을 돌려 비용을 남긴다. 모두 unused 로 정했고 여러 조각에 나눠 했으면 true */
  const measure = (label: string, records: readonly RequestRecord[]): boolean => {
    const slices = runSlices();
    const sorted = [...slices].sort((a, b) => a - b);
    const total = slices.reduce((n, t) => n + t, 0);
    console.info(
      `[#87] ${label}: ${slices.length} slices, total ${total.toFixed(1)}ms, median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms, max ${sorted.at(-1)!.toFixed(2)}ms`,
    );
    return records.every((r) => r.unused) && slices.length > 1;
  };

  it('cost: 실제 시간을 재 남긴다(응답 1건)', () => expect(measure(`${ROWS * 2}+ fibers, 1 response`, renderRows())).toBe(true));

  it('cost_burst: 함께 기다림이 끝난 응답 30건을 한 번에 판정하는 비용을 남긴다', () =>
    expect(measure(`${ROWS * 2}+ fibers, 30 responses`, renderRows(30))).toBe(true));
});
