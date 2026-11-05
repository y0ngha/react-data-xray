import { act, render } from '@testing-library/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { buildReport } from '../../report/buildReport.js';
import { buildSummary } from '../../report/summarySection.js';
import { resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { layoutTimeline } from '../../../ui/panels/timeline/timelineLayout.js';
import { getRecords } from '../store.js';
import type { RequestRecord } from '../types.js';
import { noteCommitCause } from '../../render/commitCauses.js';
import { findWaterfalls, waterfallStep } from '../waterfall.js';

// 응답 시간을 흉내 낸다(엔드포인트마다 ms 뒤에 응답).
const DELAYS: Record<string, number> = { '/api/user': 30, '/api/orders': 20, '/api/items': 10, '/api/config': 25, '/api/side': 5 };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 요청을 보낸 컴포넌트는 호출 스택의 대문자 함수 이름으로 짐작한다. 그래서 effect 함수에 컴포넌트 이름을 붙인다.
const get = (url: string) => fetch(url).then((r) => r.json() as Promise<{ list: Array<{ id: number }> }>);

const Items = () => {
  useEffect(function Items() {
    void get('/api/items');
  }, []);
  return null;
};

const Orders = ({ user }: { user: { list: Array<{ id: number }> } }) => {
  const [orders, setOrders] = useState<{ list: Array<{ id: number }> } | null>(null);
  useEffect(function Orders() {
    void get('/api/orders').then(setOrders);
  }, []);
  return orders ? <Items key={user.list[0].id} /> : null;
};

// 응답으로 마운트된 컴포넌트가 useLayoutEffect 에서 보내는 요청(commit 순번이 오르기 전에 나간다)
const LayoutOrders = () => {
  useLayoutEffect(function LayoutOrders() {
    void get('/api/orders');
  }, []);
  return null;
};

// 처음부터 마운트돼 병렬로 보내는 컴포넌트
const Sidebar = () => {
  useEffect(function Sidebar() {
    void get('/api/side');
  }, []);
  return null;
};

const Page = ({ layout = false }: { layout?: boolean }) => {
  const [user, setUser] = useState<{ list: Array<{ id: number }> } | null>(null);
  useEffect(function Page() {
    void get('/api/user').then(setUser);
    void get('/api/config'); // 같은 때 병렬로 나간 요청
  }, []);
  return (
    <>
      <Sidebar />
      {user && (layout ? <LayoutOrders /> : <Orders user={user} />)}
    </>
  );
};

const settle = async () => {
  // 고리 끝까지(응답 → commit → effect → 다음 요청) 몇 바퀴 돈다.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await wait(40);
    });
    await flush();
  }
};

const byPath = (path: string): RequestRecord => getRecords().find((r) => r.url.endsWith(path))!;

beforeEach(() => {
  setRenderMonitoring(true);
  resetRenderStats();
  mockFetch.mockImplementation(async (input) => {
    const url = String(input);
    await wait(DELAYS[url] ?? 1);
    return jsonResponse({ list: [{ id: 1 }] });
  });
});

afterEach(() => setRenderMonitoring(false));

describe('이슈 86: 응답 → 마운트 → 요청 워터폴', () => {
  it('chain: 응답이 마운트한 컴포넌트가 보낸 요청을 이어 깊이 3 고리와 응답 시간 합을 낸다', async () => {
    render(<Page />);
    await settle();
    const [user, orders, items] = ['/api/user', '/api/orders', '/api/items'].map(byPath);
    expect(orders.component).toBe('Orders');
    expect(orders.waterfallFrom).toBe(user.id);
    expect(items.waterfallFrom).toBe(orders.id);
    const report = buildReport(true);
    expect(report.requests.waterfalls).toHaveLength(1);
    const [w] = report.requests.waterfalls;
    expect(w.chain.map((s) => [s.endpoint, s.component])).toEqual([
      ['GET /api/user', 'Page'],
      ['GET /api/orders', 'Orders'],
      ['GET /api/items', 'Items'],
    ]);
    expect(w.depth).toBe(3);
    expect(w.count).toBe(1);
    expect(w.latencyMs).toBe(w.chain.reduce((n, s) => n + s.ms, 0));
    expect(w.latencyMs).toBeGreaterThanOrEqual(55);
    expect(w.chain[1].location).toContain('issue86.test.tsx');
    const finding = report.summary.topFindings.find((f) => f.kind === 'waterfall');
    expect(finding).toMatchObject({
      severity: 'medium',
      target: { endpoint: 'GET /api/items', component: 'Items' },
      evidence: { depth: 3, latencyMs: w.latencyMs, count: 1 },
      detail: 'requests.waterfalls[0]',
    });
    expect(finding?.fix).toMatch(/parallel or prefetch.*server or move it into a route loader/);
  });

  it('parallel: 같은 때 병렬로 나간 요청(처음 마운트된 형제, 같은 effect 의 다른 요청)은 고리로 보지 않는다', async () => {
    render(<Page />);
    await settle();
    expect(byPath('/api/config').waterfallFrom).toBeUndefined();
    expect(byPath('/api/side').waterfallFrom).toBeUndefined();
    expect(byPath('/api/user').waterfallFrom).toBeUndefined();
    const endpoints = buildReport(true).requests.waterfalls.flatMap((w) => w.chain.map((s) => s.endpoint));
    expect(endpoints).not.toContain('GET /api/config');
    expect(endpoints).not.toContain('GET /api/side');
  });

  it('layout_effect: useLayoutEffect 가 보낸 요청(다음 commit 순번)도 고리로 잇는다', async () => {
    render(<Page layout />);
    await settle();
    expect(byPath('/api/orders').component).toBe('LayoutOrders');
    expect(byPath('/api/orders').waterfallFrom).toBe(byPath('/api/user').id);
  });

  it('monitoring_off: 렌더 감시가 꺼져 있으면 근거가 없어 고리를 만들지 않는다', async () => {
    setRenderMonitoring(false);
    render(<Page />);
    await settle();
    expect(getRecords().filter((r) => r.waterfallFrom !== undefined)).toEqual([]);
    setRenderMonitoring(true);
  });

  it('timeline: 둘 다 보이는 고리를 앞 막대 끝에서 뒤 막대 시작으로 잇는다', async () => {
    render(<Page />);
    await settle();
    const records = getRecords();
    const layout = layoutTimeline(records, [], Date.now(), 400, () => 'ok');
    expect(layout.links.map((l) => [pathOfRecord(l.from), pathOfRecord(l.to)])).toEqual([
      ['/api/user', '/api/orders'],
      ['/api/orders', '/api/items'],
    ]);
    const link = layout.links[0];
    const fromBar = layout.bars.find((b) => b.record === link.from)!;
    const toBar = layout.bars.find((b) => b.record === link.to)!;
    expect(link.x1).toBeCloseTo(fromBar.x + fromBar.width);
    expect(link.x2).toBeCloseTo(toBar.x);
    // 앞 요청이 20초 창 밖이면 화살표를 그리지 않는다
    const onlyLater = layoutTimeline(
      records.filter((r) => !r.url.endsWith('/api/user')),
      [],
      Date.now(),
      400,
      () => 'ok',
    );
    expect(onlyLater.links.map((l) => pathOfRecord(l.to))).toEqual(['/api/items']);
  });
});

const pathOfRecord = (r: RequestRecord) => r.url;

describe('이슈 86: 고리 묶기 (기록 단위)', () => {
  let id = 0;
  const rec = (url: string, extra: Partial<RequestRecord> = {}): RequestRecord => ({
    id: ++id,
    kind: 'fetch',
    method: 'GET',
    url,
    status: 200,
    startedAt: 0,
    durationMs: 100,
    body: undefined,
    ...extra,
  });

  it('group: 같은 고리는 합쳐 세고, 첫 요청이 같으면(목록 행마다 같은 요청) 한 번으로 센다', () => {
    const a1 = rec('/a', { durationMs: 100 });
    const b1 = rec('/b?id=1', { waterfallFrom: a1.id, component: 'Row', durationMs: 50 });
    const b2 = rec('/b?id=2', { waterfallFrom: a1.id, component: 'Row', durationMs: 70 });
    const a2 = rec('/a', { durationMs: 300 });
    const b3 = rec('/b?id=3', { waterfallFrom: a2.id, component: 'Row', durationMs: 90 });
    const lone = rec('/c');
    const [w] = findWaterfalls([a1, b1, b2, a2, b3, lone], () => undefined);
    expect(w).toEqual({
      chain: [
        { endpoint: 'GET /a', ms: Math.round((100 + 100 + 300) / 3) },
        { endpoint: 'GET /b', component: 'Row', ms: Math.round((50 + 70 + 90) / 3) },
      ],
      depth: 2,
      latencyMs: 167 + 70,
      count: 2,
    });
  });

  it('started_before_response: 마운트 근거가 있어도 앞 응답이 오기 전에 시작한 요청(병렬)은 잇지 않는다', () => {
    const a = rec('/a', { startedAt: 1_000, durationMs: 100 });
    noteCommitCause('Late', 500, { time: 1_100, mounted: true, causedBy: a.id });
    const parallel = rec('/b', { startedAt: 1_050, commitSeq: 500, component: 'Late' });
    const after = rec('/b', { startedAt: 1_101, commitSeq: 500, component: 'Late' });
    const tooLate = rec('/b', { startedAt: 3_200, commitSeq: 500, component: 'Late' });
    const replay = rec('/b', { startedAt: 1_102, commitSeq: 500, component: 'Late', strictModeReplay: true });
    [parallel, after, tooLate, replay].forEach((r) => waterfallStep(r, [a])());
    expect([parallel, after, tooLate, replay].map((r) => r.waterfallFrom)).toEqual([undefined, a.id, undefined, undefined]);
  });

  it('dropped_parent: 앞 요청이 기록에서 밀려나면 남은 요청부터 잇고, 하나만 남으면 고리가 아니다', () => {
    const b = rec('/b', { waterfallFrom: 9999 });
    const c = rec('/c', { waterfallFrom: b.id });
    const d = rec('/d', { waterfallFrom: 8888 });
    expect(findWaterfalls([b, c, d], () => undefined).map((w) => w.chain.map((s) => s.endpoint))).toEqual([['GET /b', 'GET /c']]);
  });

  it('summary_savings: 병렬로 보냈을 때 줄 지연(합 − 가장 긴 응답)을 savings.ms 로 낸다', () => {
    const waterfalls = [
      {
        chain: [
          { endpoint: 'GET /a', ms: 300 },
          { endpoint: 'GET /b', component: 'B', location: 'at B (src/B.tsx:3:1)', ms: 200 },
        ],
        depth: 2,
        latencyMs: 500,
        count: 1,
      },
    ];
    const noQuery = { findings: [] } as unknown as Parameters<typeof buildSummary>[1];
    const noRenders = { monitoring: true, components: [] } as unknown as Parameters<typeof buildSummary>[2];
    const s = buildSummary({ total: 2, dropped: 0, endpoints: [], waterfalls }, noQuery, noRenders, new Map());
    expect(s.topFindings).toEqual([
      expect.objectContaining({
        kind: 'waterfall',
        target: { endpoint: 'GET /b', component: 'B', location: 'at B (src/B.tsx:3:1)' },
        savings: { ms: 200 },
      }),
    ]);
  });
});
