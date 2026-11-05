import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BODY, flush } from '../../../testing/fetchMock.js';
import { RequestActionsProvider } from '../../../ui/contexts.js';
import { shiftLabel } from '../../../ui/panels/timeline/TimelineChart.js';
import { TimelineTab } from '../../../ui/panels/timeline/TimelineTab.js';
import { layoutTimeline } from '../../../ui/panels/timeline/timelineLayout.js';
import { buildReport } from '../../report/buildReport.js';
import { buildSummary } from '../../report/summarySection.js';
import { clearRecords, getRecords } from '../../requests/store.js';
import { isQueuePending } from '../../scheduler/idleQueue.js';
import { getLayoutShifts, layoutShiftSupported, resetLayoutShifts, trackLayoutShifts } from '../layoutShifts.js';
import { getCommits, ignoreComponent, resetRenderStats, setRenderMonitoring } from '../monitor.js';

type Callback = (list: { getEntries: () => unknown[] }) => void;
let observed: { callback: Callback; options: unknown } | undefined;

class FakeObserver {
  static supportedEntryTypes = ['layout-shift', 'paint'];
  constructor(private readonly callback: Callback) {}
  observe(options: unknown) {
    observed = { callback: this.callback, options };
  }
}

/** 브라우저가 layout-shift 항목을 보낸 것처럼 콜백을 부른다. at 은 Date.now 시계의 ms epoch */
const emitShift = (value: number, nodes: Array<Node | null>, extra: { hadRecentInput?: boolean; at?: number } = {}) =>
  observed!.callback({
    getEntries: () => [
      {
        value,
        // 브라우저처럼 performance.now 시계로 준다(지금보다 얼마 앞인지만 맞춘다).
        startTime: performance.now() - (Date.now() - (extra.at ?? Date.now())),
        hadRecentInput: extra.hadRecentInput ?? false,
        sources: nodes.map((node) => ({ node })),
      },
    ],
  });

const Footer = () => <footer>footer</footer>;
function Page() {
  const [items, setItems] = useState<Array<{ id: number; title: string }> | null>(null);
  useEffect(() => {
    void fetch('/api/items')
      .then((r) => r.json())
      .then((json: typeof DEFAULT_BODY) => setItems(json.data.list));
  }, []);
  return (
    <main>
      <ul>{items?.map((i) => <li key={i.id}>{i.title}</li>) ?? <li>loading</li>}</ul>
      <Footer />
    </main>
  );
}

const loadPage = async () => {
  render(<Page />);
  await act(flush);
  await act(flush);
  return screen.getByText('footer');
};

describe('지원하지 않는 브라우저 (#89)', () => {
  it('unsupported: PerformanceObserver 가 없거나 layout-shift 를 주지 않으면 오류 없이 꺼지고 보고서에 layoutShifts 가 없다', () => {
    expect(() => trackLayoutShifts()).not.toThrow(); // jsdom 에는 PerformanceObserver 가 없다
    vi.stubGlobal('PerformanceObserver', Object.assign(vi.fn(), { supportedEntryTypes: ['paint'] }));
    expect(() => trackLayoutShifts()).not.toThrow();
    vi.stubGlobal('PerformanceObserver', vi.fn()); // supportedEntryTypes 자체가 없는 옛 브라우저
    expect(() => trackLayoutShifts()).not.toThrow();
    vi.unstubAllGlobals();
    expect(layoutShiftSupported()).toBe(false);
    expect(buildReport(false)).not.toHaveProperty('layoutShifts');
  });
});

describe('레이아웃 이동을 응답과 컴포넌트로 잇는다 (#89)', () => {
  beforeAll(() => {
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    trackLayoutShifts();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setRenderMonitoring(false);
    resetRenderStats();
    resetLayoutShifts(0);
  });

  it('observe_buffered: buffered 로 layout-shift 를 듣는다', () => {
    expect(layoutShiftSupported()).toBe(true);
    expect(observed?.options).toEqual({ type: 'layout-shift', buffered: true });
  });

  it('shift_cause: 밀린 노드의 컴포넌트와, 직전 commit 에서 그 조상을 렌더한 응답·컴포넌트를 잇는다(콜백에서는 분석하지 않는다)', async () => {
    setRenderMonitoring(true);
    const footer = await loadPage();
    emitShift(0.2, [footer.firstChild]); // 글자 노드도 그 요소의 컴포넌트로 본다
    expect(getLayoutShifts()).toHaveLength(0);
    expect(isQueuePending()).toBe(true);
    await act(flush);
    const [shift] = getLayoutShifts();
    expect(shift.value).toBe(0.2);
    expect(shift.component?.name).toBe('Footer');
    // 요청 기록은 들지 않고 id 와 엔드포인트만 둔다.
    expect(shift.cause).not.toHaveProperty('record');
    expect(getRecords().find((r) => r.id === shift.cause?.recordId)?.url).toBe('/api/items');
    expect(shift.cause?.endpoint).toBe('GET /api/items');
    // Footer 는 부모를 따라 렌더됐으므로, 응답을 직접 받은 Page 를 원인 컴포넌트로 쓴다.
    expect(shift.cause).toMatchObject({ component: 'Page', via: 'direct' });

    const report = buildReport(true);
    expect(report.layoutShifts).toEqual([
      expect.objectContaining({
        value: 0.2,
        component: 'Footer',
        cause: expect.objectContaining({ endpoint: 'GET /api/items', component: 'Page' }),
      }),
    ]);
    const finding = report.summary.topFindings.find((f) => f.kind === 'layout-shift');
    expect(finding).toMatchObject({
      severity: 'medium',
      target: { endpoint: 'GET /api/items', component: 'Page' },
      evidence: { shifts: 1, score: 0.2 },
      detail: 'layoutShifts[0]',
    });
    expect(finding?.fix).toMatch(/min-height/);
    expect(report.summary.verdict).toContain('1 component moved by large layout shifts');
  });

  it('recent_input: 입력 직후(hadRecentInput)의 이동은 뺀다', async () => {
    const footer = await loadPage();
    emitShift(0.3, [footer], { hadRecentInput: true });
    await act(flush);
    expect(getLayoutShifts()).toHaveLength(0);
  });

  it('own_panel: 밀린 노드가 모두 rdx 패널 것이면 기록하지 않는다', async () => {
    const Panel = () => <aside>rdx panel</aside>;
    ignoreComponent(Panel);
    render(<Panel />);
    emitShift(0.3, [screen.getByText('rdx panel')]);
    await act(flush);
    expect(getLayoutShifts()).toHaveLength(0);
  });

  it('no_cause: 렌더 감시가 꺼져 있었거나 commit 이 1초보다 앞서면 원인 없이 컴포넌트만 남기고, 작은 이동은 summary 에 올리지 않는다', async () => {
    const footer = await loadPage();
    emitShift(0.05, [footer]);
    setRenderMonitoring(true);
    emitShift(0.01, [footer], { at: Date.now() + 5000 });
    emitShift(0.02, [null], { at: Date.now() + 1 }); // 이미 지워진 노드(감시를 켠 뒤)
    await act(flush);
    const shifts = getLayoutShifts();
    expect(shifts.map((s) => [s.component?.name, s.cause, s.causeUnavailable])).toEqual([
      ['Footer', undefined, 'render-monitoring-off'],
      ['Footer', undefined, undefined],
      [undefined, undefined, undefined],
    ]);
    const report = buildReport(true);
    expect(report.layoutShifts?.map((r) => r.value)).toEqual([0.05, 0.02, 0.01]);
    expect(report.layoutShifts?.[0].causeUnavailable).toBe('render-monitoring-off');
    expect(report.howToRead?.some((l) => l.includes("causeUnavailable 'render-monitoring-off'"))).toBe(true);
    expect(report.summary.topFindings.some((f) => f.kind === 'layout-shift')).toBe(false);
    expect(report.summary.verdict).not.toContain('layout shift');
  });

  it('reset: reset 뒤에는 그 전 이동을 싣지 않는다', async () => {
    const footer = await loadPage();
    emitShift(0.2, [footer]);
    await act(flush);
    resetLayoutShifts();
    emitShift(0.2, [footer], { at: Date.now() - 10_000 }); // reset 전에 일어나 늦게 받은 이동
    await act(flush);
    expect(getLayoutShifts()).toHaveLength(0);
  });

  it('timeline: 최근 20초의 이동을 점수만큼 그리고, 툴팁에 밀린 컴포넌트와 원인 요청을 적는다', async () => {
    setRenderMonitoring(true);
    const footer = await loadPage();
    emitShift(0.5, [footer]);
    emitShift(0.1, [footer], { at: Date.now() - 30_000 });
    await act(flush);
    const now = Date.now();
    const layout = layoutTimeline([], [], now, 400, () => 'ok', [], getLayoutShifts());
    expect(layout.shifts).toHaveLength(1);
    expect(layout.shifts[0].height).toBe(40);
    expect(shiftLabel(layout.shifts[0].shift)).toMatch(/layout shift 0\.500 · moved: <Footer> · after GET \/api\/items rendered <Page>/);
    expect(shiftLabel({ id: 0, time: now, value: 0.1 })).toContain('no network cause found');
    expect(shiftLabel({ id: 0, time: now, value: 0.1, causeUnavailable: 'render-monitoring-off' })).toContain('render monitoring was off');
  });

  it('clock_drift: performance 시계가 Date.now 와 어긋나도 콜백 때의 차이로 바꿔 직전 commit 을 찾는다', async () => {
    setRenderMonitoring(true);
    const footer = await loadPage();
    // timeOrigin + now() 가 Date.now 보다 1분 앞선 브라우저(시스템 시간 조정 뒤 등)
    vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(performance.timeOrigin + 60_000);
    vi.spyOn(performance, 'now').mockReturnValue(5_000);
    observed!.callback({ getEntries: () => [{ value: 0.2, startTime: 5_000, hadRecentInput: false, sources: [{ node: footer }] }] });
    vi.restoreAllMocks();
    await act(flush);
    const [shift] = getLayoutShifts();
    expect(Math.abs(shift.time - Date.now())).toBeLessThan(200);
    expect(shift.cause?.endpoint).toBe('GET /api/items');
  });

  it('pick_before: 이동 시각 이전 렌더가 있으면 한 프레임 안의 늦은 렌더보다 그것을 원인으로 본다', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    setRenderMonitoring(true);
    function Toggle() {
      const [on, setOn] = useState(false);
      return (
        <>
          <button onClick={() => setOn(true)}>{on ? 'on' : 'off'}</button>
          <Page />
        </>
      );
    }
    render(<Toggle />);
    await act(flush);
    await act(flush);
    now += 500; // 응답과 무관한 다음 commit
    fireEvent.click(screen.getByText('off'));
    await act(flush);
    expect(
      getCommits()
        .map((c) => c.time)
        .slice(-2),
    ).toEqual([now - 500, now]);
    emitShift(0.2, [screen.getByText('footer')], { at: now - 10 }); // 다음 commit 10ms 전
    await act(flush);
    expect(getLayoutShifts()[0].cause).toMatchObject({ endpoint: 'GET /api/items', component: 'Page' });
  });

  it('inferred: 밀린 컴포넌트·조상에 원인이 없으면(위 형제가 커짐) 직전에 응답으로 렌더된 commit 을 likely 원인으로 둔다', async () => {
    setRenderMonitoring(true);
    const Content = () => <p>content</p>;
    function Banner() {
      const [text, setText] = useState<string | null>(null);
      useEffect(() => {
        void fetch('/api/banner')
          .then((r) => r.json())
          .then((json: typeof DEFAULT_BODY) => setText(json.data.list[0].title));
      }, []);
      return <div>{text ?? ''}</div>;
    }
    render(
      <section>
        <Banner />
        <Content />
      </section>,
    );
    await act(flush);
    await act(flush);
    emitShift(0.3, [screen.getByText('content')]);
    await act(flush);
    const [shift] = getLayoutShifts();
    expect(shift.component?.name).toBe('Content');
    expect(shift.cause).toMatchObject({ endpoint: 'GET /api/banner', component: 'Banner', inferred: true });
    expect(shiftLabel(shift)).toContain('likely after GET /api/banner rendered <Banner>');
    const row = buildReport(true).layoutShifts?.[0];
    expect(row?.cause).toMatchObject({ endpoint: 'GET /api/banner', component: 'Banner', inferred: true });
  });

  it('evicted: 원인 요청이 목록에서 밀려났으면 이동 표시를 눌러도 상세 대신 그렇다고 알린다', async () => {
    setRenderMonitoring(true);
    const footer = await loadPage();
    emitShift(0.2, [footer]);
    await act(flush);
    const open = vi.fn<(record: unknown) => void>();
    const ui = render(
      <RequestActionsProvider value={{ open, hover: () => undefined, classOf: () => 'ok' }}>
        <TimelineTab records={getRecords()} />
      </RequestActionsProvider>,
    );
    const mark = () => Array.from(ui.container.querySelectorAll('rect')).find((r) => r.textContent?.includes('layout shift'))!;
    fireEvent.click(mark());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/items' }));
    act(() => clearRecords());
    fireEvent.click(mark());
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('Request no longer in the list: GET /api/items');
  });

  it('summary_all_shifts: summary 는 보고서에 싣는 20개로 자르기 전 전부로 묶는다', async () => {
    setRenderMonitoring(true);
    const footer = await loadPage();
    for (let i = 0; i < 20; i++) emitShift(0.09, [null]);
    for (let i = 0; i < 4; i++) emitShift(0.03, [footer]);
    await act(flush);
    const report = buildReport(true);
    expect(report.layoutShifts).toHaveLength(20);
    expect(report.layoutShifts?.some((r) => r.component === 'Footer')).toBe(false);
    const finding = report.summary.topFindings.find((f) => f.kind === 'layout-shift');
    expect(finding).toMatchObject({ target: { component: 'Page', endpoint: 'GET /api/items' }, evidence: { shifts: 4, score: 0.12 } });
    expect(finding).not.toHaveProperty('detail'); // 실린 행 밖이라 상세 경로가 없다
    // 컴포넌트도 원인도 모르는 이동(0.09 x 20)은 고칠 곳이 없어 올리지 않는다.
    expect(report.summary.topFindings.filter((f) => f.kind === 'layout-shift')).toHaveLength(1);
  });

  it('summary_grouping: 같은 컴포넌트·원인의 작은 이동이 합쳐 0.1 을 넘으면 하나의 finding 이다', () => {
    const empty = { total: 0, dropped: 0, endpoints: [], nPlusOne: [] };
    const renders = { monitoring: true, windowSeconds: 10, truncated: false, droppedInstances: 0, components: [] };
    const row = { value: 0.06, secondsAgo: 1, component: 'Card', renderedAt: 'src/Card.tsx:3' };
    const summary = buildSummary(empty, { findings: [] } as never, renders as never, new Map(), [row, row, { ...row, component: 'Other' }]);
    expect(summary.topFindings).toEqual([
      expect.objectContaining({
        kind: 'layout-shift',
        target: { component: 'Card', location: 'src/Card.tsx:3' },
        evidence: { shifts: 2, score: 0.12 },
      }),
    ]);
  });

  it('verdict_components: verdict 는 밀린 컴포넌트(이름·위치)를 한 번씩만 세고, 컴포넌트를 모르는 이동은 세지 않는다', () => {
    const empty = { total: 0, dropped: 0, endpoints: [], nPlusOne: [] };
    const renders = { monitoring: true, windowSeconds: 10, truncated: false, droppedInstances: 0, components: [] };
    const card = { value: 0.2, secondsAgo: 1, component: 'Card', renderedAt: 'src/Card.tsx:3' };
    const rows = [
      { ...card, cause: { endpoint: 'GET /a', component: 'List' } },
      { ...card, cause: { endpoint: 'GET /b', component: 'List' } },
      { value: 0.3, secondsAgo: 1, cause: { endpoint: 'GET /c', component: 'Feed' } },
    ];
    const summary = buildSummary(empty, { findings: [] } as never, renders as never, new Map(), rows);
    expect(summary.topFindings.filter((f) => f.kind === 'layout-shift')).toHaveLength(3);
    expect(summary.verdict).toContain('1 component moved by large layout shifts');
  });
});
