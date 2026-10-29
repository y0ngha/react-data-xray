import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRenderGroups, reportWindowMs, resetRenderStats, setRenderMonitoring } from '../../../../core/render/monitor.js';
import { buildRenderSection } from '../../../../core/report/renderSection.js';
import { flushQueue } from '../../../../core/scheduler/idleQueue.js';
import { RendersTab } from '../RendersTab.js';

function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN((v) => v + 1)}>bump{n}</button>;
}

beforeEach(() => {
  setRenderMonitoring(true);
  resetRenderStats();
});
afterEach(() => setRenderMonitoring(false));

describe('reset 뒤 렌더 구간(#16)', () => {
  it('reset 안 했으면 10초, 했으면 reset 뒤(최대 2분)', async () => {
    const now = Date.now();
    vi.resetModules();
    const fresh = await import('../../../../core/render/monitor.js');
    expect(fresh.reportWindowMs(now)).toBe(10_000);
    const reset = now - 45_000;
    const realNow = Date.now;
    Date.now = () => reset;
    resetRenderStats();
    Date.now = realNow;
    expect(reportWindowMs(now)).toBe(45_000);
    expect(reportWindowMs(now + 200_000)).toBe(120_000);
  });

  it('same_counts: reset 후 같은 구간에서 렌더 탭 횟수와 보고서 횟수가 같다', () => {
    render(<Counter />);
    render(<RendersTab statsByEndpoint={new Map()} />);
    for (let i = 0; i < 3; i++) act(() => fireEvent.click(screen.getByText(/bump/)));
    flushQueue();
    const now = Date.now() + 5_000;
    const tab = getRenderGroups(now, reportWindowMs(now)).groups.find((g) => g.name === 'Counter');
    const rep = buildRenderSection(true, now).components.find((c) => c.name === 'Counter');
    expect(tab?.recent).toBeGreaterThan(0);
    expect(rep?.renders).toBe(tab?.recent);
  });

  it('window_label: 기본은 최근 10초', async () => {
    render(<RendersTab statsByEndpoint={new Map()} />);
    await act(async () => flushQueue());
    expect(screen.getByText(/last 10s/)).toBeTruthy();
  });

  it('window_label: reset 뒤 오래 지나면 시각 이후 N초', async () => {
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0;
    resetRenderStats();
    Date.now = () => t0 + 47_000;
    render(<RendersTab statsByEndpoint={new Map()} />);
    await act(async () => flushQueue());
    Date.now = realNow;
    expect(screen.getByText(/since \d\d:\d\d:\d\d \(47s\)/)).toBeTruthy();
  });
});
