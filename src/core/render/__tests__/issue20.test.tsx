import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getRenderGroups, MAX_GROUPED_INSTANCES, resetRenderStats, setRenderMonitoring } from '../monitor.js';
import { buildRenderSection } from '../../report/renderSection.js';

const Noise = () => <i />;
const Row = () => <b />;
let bump: () => void = () => {};
const Screen = ({ noise, rows }: { noise: number; rows: number }) => {
  const [n, setN] = useState(0);
  useEffect(() => {
    bump = () => setN((x) => x + 1);
  }, []);
  return (
    <div data-n={n}>
      {Array.from({ length: noise }, (_, i) => (
        <Noise key={`n${i}`} />
      ))}
      {Array.from({ length: rows }, (_, i) => (
        <Row key={`r${i}`} />
      ))}
    </div>
  );
};

beforeEach(() => setRenderMonitoring(true));
afterEach(() => {
  cleanup();
  resetRenderStats();
});

const renderTimes = (times: number) => {
  render(<Screen noise={600} rows={106} />);
  for (let i = 1; i < times; i++) act(() => bump());
  flushQueue();
};

describe('보고서 렌더 집계 상한 (#20)', () => {
  it('rows_counted: 잡음 600개 + 행 106개 x 25렌더 → 행 그룹 instances 106, renders 2650', () => {
    renderTimes(25);
    const row = getRenderGroups(Date.now(), 10_000).groups.find((g) => g.name === 'Row')!;
    expect(row.instances).toBe(106);
    expect(row.recent).toBe(2650);
    const section = buildRenderSection(true, Date.now());
    const comp = section.components.find((c) => c.name === 'Row')!;
    expect([comp.instances, comp.renders]).toEqual([106, 2650]);
    expect(section.truncated).toBe(false);
  });

  it('truncation_flag: 상한을 넘으면 truncated 와 버린 수', () => {
    render(<Screen noise={MAX_GROUPED_INSTANCES + 10} rows={0} />);
    flushQueue();
    const r = getRenderGroups(Date.now(), 10_000);
    expect(r.truncated).toBe(true);
    expect(r.droppedInstances).toBeGreaterThan(0);
    expect(buildRenderSection(true, Date.now()).truncated).toBe(true);
  });
});
