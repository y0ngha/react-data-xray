import { act, fireEvent, render, screen } from '@testing-library/react';
import { memo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRenderGroups, renderGroupsSteps, resetRenderStats, setRenderMonitoring } from '../../../../core/render/monitor.js';
import { summarize } from '../../../../core/render/summary.js';
import { flushQueue } from '../../../../core/scheduler/idleQueue.js';
import { RendersTab } from '../RendersTab.js';

vi.mock('../../../../core/render/monitor.js', async (original) => {
  const real = await original<typeof import('../../../../core/render/monitor.js')>();
  return { ...real, renderGroupsSteps: vi.fn<typeof real.renderGroupsSteps>(real.renderGroupsSteps) };
});

vi.mock('../../../../core/render/summary.js', async (original) => {
  const real = await original<typeof import('../../../../core/render/summary.js')>();
  return { ...real, summarize: vi.fn<typeof real.summarize>(real.summarize) };
});

const Cell = memo(function Cell({ n }: { n: number }) {
  return <td>{n}</td>;
});
function Table({ size }: { size: number }) {
  const [n, setN] = useState(0);
  return (
    <table>
      <tbody>
        <tr>
          <td>
            <button onClick={() => setN((v) => v + 1)}>bump</button>
          </td>
        </tr>
        <tr>
          {Array.from({ length: size }, (_, i) => (
            <Cell key={i} n={n} />
          ))}
        </tr>
      </tbody>
    </table>
  );
}

beforeEach(() => {
  setRenderMonitoring(true);
  resetRenderStats();
  vi.mocked(renderGroupsSteps).mockClear();
});
afterEach(() => setRenderMonitoring(false));

describe('렌더 탭 비용(#32)', () => {
  it('hidden_tab_no_work: 요청 상세가 탭을 덮으면(display:none) 요약 계산을 부르지 않는다', async () => {
    render(
      <div style={{ display: 'none' }}>
        <RendersTab statsByEndpoint={new Map()} />
      </div>,
    );
    await act(async () => {
      flushQueue();
    });
    expect(renderGroupsSteps).not.toHaveBeenCalled();
  });

  it('보이는 탭은 렌더 중이 아니라 유휴 큐에서 계산하고 결과를 그린다', async () => {
    render(<Table size={3} />);
    render(<RendersTab statsByEndpoint={new Map()} />);
    expect(renderGroupsSteps).not.toHaveBeenCalled();
    await act(async () => {
      flushQueue();
    });
    expect(renderGroupsSteps).toHaveBeenCalled();
    expect(screen.queryByText('계산 중')).toBeNull();
  });

  it('bench_under_budget: 인스턴스 2000개, 기록이 그대로면 두 번째 요약은 요약 함수를 다시 부르지 않는다', () => {
    render(<Table size={2000} />);
    act(() => fireEvent.click(screen.getByText('bump')));
    flushQueue();
    const now = Date.now();
    const run = () => getRenderGroups(now, 10_000);
    // 절대 시간은 병렬 부하에 흔들리므로, 기록이 그대로일 때 요약 함수를 다시 부르지 않는지로 본다.
    run();
    const calls = vi.mocked(summarize).mock.calls.length;
    run();
    expect(vi.mocked(summarize).mock.calls.length).toBe(calls);
  });
});
