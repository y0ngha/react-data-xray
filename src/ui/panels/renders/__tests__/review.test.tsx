import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Hit } from '../../../../core/inspect/types.js';
import { type RenderGroup } from '../../../../core/render/groups.js';
import { resetRenderStats, setRenderMonitoring } from '../../../../core/render/monitor.js';
import { enqueue, flushQueue } from '../../../../core/scheduler/idleQueue.js';
import { RenderGroupRow } from '../RenderGroupRow.js';
import { RendersTab } from '../RendersTab.js';
import { useRenderGroups } from '../useRenderGroups.js';

let bodyRuns = 0;
function Counter() {
  const [n, setN] = useState(0);
  bodyRuns++;
  return <button onClick={() => setN((v) => v + 1)}>bump{n}</button>;
}

const named = (i: number) => {
  const C = () => <i>{i}</i>;
  C.displayName = `Item${i}`;
  return C;
};

beforeEach(() => {
  setRenderMonitoring(true);
  resetRenderStats();
  bodyRuns = 0;
});
afterEach(() => {
  cleanup();
  setRenderMonitoring(false);
});

const host = { current: null };

describe('렌더 탭 계산(리뷰 반영)', () => {
  it('queue_backed_up: 큐가 1초 넘게 밀려 tick 이 계속 와도 계산은 취소되지 않아 결과가 나온다', () => {
    render(<Counter />);
    act(() => fireEvent.click(screen.getByText(/bump/)));
    let calls = 0;
    enqueue(() => ++calls > 5); // 앞선 일이 오래 걸리는 큐
    const base = Date.now();
    const { result, rerender } = renderHook(({ now }) => useRenderGroups(now, null, host, () => undefined, 'avoidable'), {
      initialProps: { now: base },
    });
    for (let i = 1; i <= 40; i++) {
      act(() => {
        flushQueue(0); // 한 step 만
        rerender({ now: base + i * 1000 });
      });
    }
    expect(result.current?.items.some((item) => item.group.name === 'Counter')).toBe(true);
  });

  it('visible_only: 출처 찾기는 정렬·자른 보이는 30개에만 한다', () => {
    const items = Array.from({ length: 40 }, (_, i) => named(i));
    const List = () => (
      <>
        {items.map((C) => (
          <C key={C.displayName} />
        ))}
      </>
    );
    const { rerender } = render(<List />);
    // 모두 한 번 더 렌더
    rerender(<List />);
    flushQueue();
    const sourceOf = vi.fn<(g: RenderGroup) => Hit | undefined>(() => undefined);
    const { result } = renderHook(() => useRenderGroups(Date.now(), null, host, sourceOf, 'count'));
    act(() => {
      flushQueue();
    });
    expect(result.current?.items.length).toBeLessThanOrEqual(30);
    expect(sourceOf.mock.calls.length).toBe(result.current?.items.length);
  });

  it('no_body_rerun: 렌더 탭을 그려도(행 갱신 포함) 앱 컴포넌트 본문을 다시 실행하지 않는다', async () => {
    render(<Counter />);
    act(() => fireEvent.click(screen.getByText(/bump/)));
    const before = bodyRuns;
    render(<RendersTab statsByEndpoint={new Map()} />);
    await act(async () => {
      flushQueue();
    });
    // 행이 다시 그려지게 한다(큐는 돌리지 않는다)
    act(() => fireEvent.click(screen.getByText('횟수순')));
    expect(screen.getByText(/<Counter>/)).toBeTruthy();
    expect(bodyRuns).toBe(before);
  });
});

describe('폭주 색(RENDER_STORM)', () => {
  const group = (recent: number): RenderGroup => ({
    name: 'Card',
    instances: 1,
    fiber: {},
    recent,
    last: 0,
    ms: 0,
    reasons: { mount: 0, state: 0, context: 0, props: 0, 'same-content': 0, 'new-callback': 0, parent: 0 },
    avoidable: 0,
    sameContentKeys: [],
    callbackKeys: [],
    contextKeys: [],
    memoized: false,
    network: 0,
    causes: [],
    origins: [],
    stateHooks: [],
    compiled: false,
  });
  const colorOf = (recent: number, windowMs: number): string => {
    const { unmount } = render(<RenderGroupRow group={group(recent)} showTime={false} windowMs={windowMs} />);
    const color = screen.getByText(`${recent}회`).style.color;
    unmount();
    return color;
  };

  it('storm_scaled: 60초 구간의 50회는 10초 몫으로 환산하면 폭주가 아니다', () => {
    const calm = colorOf(1, 10_000);
    expect(colorOf(50, 10_000)).not.toBe(calm);
    expect(colorOf(50, 60_000)).toBe(calm);
    expect(colorOf(100, 60_000)).not.toBe(calm);
  });
});
