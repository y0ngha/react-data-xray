import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getEndpointStats } from '../../../core/requests/endpointStats.js';
import { classifyRecords } from '../../../core/requests/classify.js';
import { createRecord, finishRecord } from '../../../core/requests/store.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { renderWithActions } from '../../../testing/withActions.js';
import { DockPicker } from '../DockPicker.js';
import { RenderGroupRow } from '../renders/RenderGroupRow.js';
import type { RenderGroup } from '../../../core/render/groups.js';
import { CacheAuditView } from '../requests/CacheAuditView.js';
import { InspectTab } from '../inspect/InspectTab.js';
import { panelPlacement } from '../panelLayout.js';
import { RequestsTab } from '../requests/RequestsTab.js';
import { sizeFromPointer } from '../ResizeHandle.js';
import { layoutTimeline } from '../timeline/timelineLayout.js';
import { TimelineTab } from '../timeline/TimelineTab.js';

const finished = (url: string, startedAt?: number): RequestRecord => {
  const r = createRecord('fetch', 'GET', url);
  if (startedAt !== undefined) r.startedAt = startedAt;
  finishRecord(r, 200);
  return r;
};

describe('RequestsTab', () => {
  it('엔드포인트를 누르면 그 요청만 기록에 보이고, 필터를 풀 수 있으며, 무시를 켜고 끈다', () => {
    const records = [finished('/api/a'), finished('/api/a'), finished('/api/b')];
    const stats = getEndpointStats(records, classifyRecords(records, new Set()));
    const onToggleIgnore = vi.fn<(endpoint: string) => void>();
    renderWithActions(<RequestsTab records={records} stats={stats} ignored={new Set(['GET /api/b'])} onToggleIgnore={onToggleIgnore} />);
    expect(screen.getByText(/최근 3건/)).toBeTruthy();
    expect(screen.getByText('무시 해제')).toBeTruthy();
    fireEvent.click(screen.getAllByText('무시')[0]);
    expect(onToggleIgnore).toHaveBeenCalledWith('GET /api/a');
    fireEvent.click(screen.getByText('GET /api/a'));
    expect(screen.getAllByText('GET /api/a')).toHaveLength(2);
    fireEvent.click(screen.getByText('GET /api/a ✕'));
    expect(screen.getAllByText(/GET \/api\//)).toHaveLength(3);
    fireEvent.click(screen.getByText('엔드포인트별'));
    expect(screen.getByText(/2회 · 평균/)).toBeTruthy();
  });
});

describe('InspectTab', () => {
  it('검사 전, 결과 없음, 글자로 추정한 결과를 구분해 보여 준다', () => {
    const { rerender } = renderWithActions(<InspectTab result={null} stats={new Map()} />);
    expect(screen.getByText(/요소 선택\]으로 화면의 요소를 고르면/)).toBeTruthy();
    rerender(<InspectTab result={{ components: [{ depth: 0, name: 'A', hits: [], fiber: null }], guesses: [] }} stats={new Map()} />);
    expect(screen.getByText('연결된 API 응답을 찾지 못했습니다.')).toBeTruthy();
    const record = finished('/api/g');
    record.body = { v: 'x' };
    rerender(<InspectTab result={{ components: [], guesses: [{ record, path: '$.v', via: 'text', match: 'text' }] }} stats={new Map()} />);
    expect(screen.getByText(/화면 글자로 찾은 결과/)).toBeTruthy();
    expect(screen.getByText('추정')).toBeTruthy();
  });
});

describe('타임라인', () => {
  it('막대 위치, 겹치는 요청의 줄, 몰림 구간, 렌더 눈금을 계산한다', () => {
    // 페이지 진입 직후(첫 로딩)로 보이지 않도록 진입 1분 뒤로 둔다.
    const now = performance.timeOrigin + 60_000;
    const records = [0, 50, 100, 150, 200].map((d) =>
      Object.assign(finished(`/api/t${d}`), { startedAt: now - 10_000 + d, durationMs: 1000 }),
    );
    const old = Object.assign(finished('/api/old'), { startedAt: now - 60_000, durationMs: 10 });
    const layout = layoutTimeline(
      [...records, old],
      [
        { id: 1, time: now - 1000, count: 4 },
        { id: 2, time: now - 50_000, count: 1 },
      ],
      now,
      400,
    );
    expect(layout.bars).toHaveLength(5);
    expect(new Set(layout.bars.map((b) => b.y)).size).toBe(5);
    expect(layout.bars[0].x).toBeCloseTo(200);
    expect(layout.bursts).toEqual([expect.objectContaining({ count: 5, initial: false })]);
    expect(layout.commits).toEqual([expect.objectContaining({ count: 4, height: 40 })]);
    expect(layout.ticks.map((t) => t.seconds)).toEqual([0, 5, 10, 15, 20]);
  });

  it('막대에 호버하면 요약과 강조를, 클릭하면 상세를 열고, 멈출 수 있다', () => {
    const record = finished('/api/bar');
    const { actions } = renderWithActions(<TimelineTab records={[record]} />);
    const bar = screen.getByText(/GET \/api\/bar/, { selector: 'title' }).parentElement!;
    fireEvent.mouseEnter(bar);
    expect(screen.getByRole('tooltip').textContent).toContain('/api/bar');
    expect(actions.hover).toHaveBeenCalledWith(record);
    fireEvent.click(bar);
    expect(actions.open).toHaveBeenCalledWith(record);
    fireEvent.mouseLeave(bar);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByText('❚❚ 멈춤'));
    });
    expect(screen.getByText('▶ 재개')).toBeTruthy();
  });
});

describe('패널 배치', () => {
  const viewport = { width: 1000, height: 800 };
  it('도킹 방식마다 위치와 크기를 정하고, 작게 보기는 버튼 위·아래 중 공간이 있는 쪽에 둔다', () => {
    const base = { bottomHeight: 300, rightWidth: 500 };
    expect(panelPlacement({ ...base, dock: 'bottom' }, { x: 0, y: 0 }, viewport)).toMatchObject({ bottom: 0, height: 300 });
    expect(panelPlacement({ ...base, dock: 'right' }, { x: 0, y: 0 }, viewport)).toMatchObject({ right: 0, width: 500 });
    expect(panelPlacement({ ...base, dock: 'window' }, { x: 0, y: 0 }, viewport)).toMatchObject({ position: 'static' });
    expect(panelPlacement({ ...base, dock: 'float' }, { x: 900, y: 700 }, viewport)).toMatchObject({ bottom: 108, left: 464 });
    expect(panelPlacement({ ...base, dock: 'float' }, { x: 10, y: 10 }, viewport)).toMatchObject({ top: 62, left: 0 });
  });

  it('끌어서 크기를 바꾸되 최소 크기와 페이지 여백을 지킨다', () => {
    expect(sizeFromPointer('top', 0, 500, viewport)).toBe(300);
    expect(sizeFromPointer('top', 0, 790, viewport)).toBe(160);
    expect(sizeFromPointer('left', 0, 0, viewport)).toBe(920);
  });

  it('도킹 버튼은 고른 방식을 알린다', () => {
    const onChange = vi.fn<(dock: string) => void>();
    renderWithActions(<DockPicker dock="float" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('오른쪽에 도킹'));
    expect(onChange).toHaveBeenCalledWith('right');
  });
});

describe('RenderGroupRow', () => {
  it('데이터 출처 줄에 그 엔드포인트의 중복·같은 응답 수를 함께 보여 준다', () => {
    const record = finished('/api/src');
    const group: RenderGroup = {
      name: 'Card',
      instances: 2,
      fiber: {},
      recent: 4,
      last: 0,
      ms: 1.5,
      reasons: { mount: 0, state: 0, context: 0, props: 0, 'same-content': 0, 'new-callback': 0, parent: 4 },
      avoidable: 4,
      sameContentKeys: [],
      callbackKeys: [],
      contextKeys: [],
      memoized: false,
      network: 3,
      causes: [{ record, direct: 1, timing: 0, parent: 2, sameResponse: 2 }],
      origins: [{ name: 'Page', reason: 'state', count: 4 }],
      stateHooks: [],
      compiled: false,
      location: 'src/Page.tsx:12',
    };
    const stat = { endpoint: 'GET /api/src', count: 5, duplicates: 2, sameResponses: 1, review: 0, explained: 0, avgMs: 10 };
    renderWithActions(
      <RenderGroupRow group={group} source={{ record, path: '$', via: 'props.item', match: 'exact' }} stat={stat} showTime />,
    );
    expect(screen.getByText('중복 2')).toBeTruthy();
    expect(screen.getByText('같은 응답 1')).toBeTruthy();
    expect(screen.getByText(/네트워크 응답으로 3회 · 네트워크와 무관 1회/)).toBeTruthy();
    expect(screen.getByText(/그중 부모를 따라 2회/)).toBeTruthy();
    expect(screen.getByText(/React.memo 로 감싸면/)).toBeTruthy();
    expect(screen.getByText(/src\/Page\.tsx:12/)).toBeTruthy();
    expect(screen.getByText(/렌더 시작: <Page>\(state\) 4회/)).toBeTruthy();
    expect(screen.getByText(/직전과 같은 응답으로 2회/)).toBeTruthy();
  });
});

describe('React Query 보기', () => {
  it('화면에 QueryClientProvider 가 없으면 찾지 못했다고 알린다', () => {
    renderWithActions(<CacheAuditView records={[]} />);
    expect(screen.getByText(/React Query\(QueryClientProvider\)를 찾지 못했습니다/)).toBeTruthy();
  });
});
