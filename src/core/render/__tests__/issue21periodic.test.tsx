import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRenderSection } from '../../report/renderSection.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getRenderGroups, getTopRenders, resetRenderStats, setRenderMonitoring } from '../monitor.js';

// hookSitesOf 는 컴포넌트 함수를 가짜 dispatcher 로 다시 부른다. 함수 본문이 몇 번 실행됐는지로 그 재실행을 센다.
let bodyRuns = 0;
const useCounter = () => useState(0);
const Counter = () => {
  bodyRuns++;
  const [n, set] = useCounter();
  return <button onClick={() => set(n + 1)}>{`n${n}`}</button>;
};

beforeEach(() => {
  bodyRuns = 0;
  setRenderMonitoring(true);
});
afterEach(() => {
  cleanup();
  resetRenderStats();
});

describe('커스텀 훅 경로는 주기 경로에서 구하지 않는다 (#21)', () => {
  it('getTopRenders·getRenderGroups 는 앱 컴포넌트 함수를 다시 부르지 않고, 보고서만 경로를 붙인다', () => {
    render(<Counter />);
    fireEvent.click(screen.getByText(/^n/));
    flushQueue();
    const before = bodyRuns;
    getTopRenders(500);
    const { groups } = getRenderGroups();
    expect(groups.find((g) => g.name === 'Counter')!.stateHooks[0].label).toBe('useState #1');
    expect(bodyRuns).toBe(before);
    const c = buildRenderSection(true, Date.now()).components.find((x) => x.name === 'Counter')!;
    expect(bodyRuns).toBeGreaterThan(before);
    expect(c.stateChanges[0].label).toBe('useCounter › useState #1');
  });
});
