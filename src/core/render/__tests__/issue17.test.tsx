import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupRenders } from '../groups.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildRenderSection } from '../../report/renderSection.js';
import { resetRenderStats, setRenderMonitoring } from '../monitor.js';
import { summarize } from '../summary.js';
import type { RenderEntry, RenderEvent } from '../types.js';

let bump: () => void = () => {};
const Child = ({ n }: { n: number }) => <i>{n}</i>;
const Parent = () => {
  const [n, setN] = useState(0);
  useEffect(() => {
    bump = () => setN((x) => x + 1);
  }, []);
  return <Child n={n % 1} />;
};

beforeEach(() => setRenderMonitoring(true));
afterEach(() => {
  cleanup();
  resetRenderStats();
});

const entryOf = (name: string, events: Array<Partial<RenderEvent>>, now: number): RenderEntry => ({
  name,
  fiber: null,
  memoized: false,
  events: events.map((e) => ({ time: now, reason: 'parent', ...e })),
});

describe('보고서 렌더 시간 (#17)', () => {
  it('actual_duration_basis: 시간 기록이 없으면 time 을 쓰지 않는다', () => {
    const now = Date.now();
    const e = entryOf('A', [{ reason: 'parent' }], now);
    const s = summarize(e, now);
    expect(s.timed).toBe(0);
  });

  it('합계·줄일 수 있는 시간·하위 시간을 합친다', () => {
    const now = Date.now();
    const parent = entryOf('P', [{ reason: 'state', ms: 1 }], now);
    const child = entryOf(
      'C',
      [
        { reason: 'parent', ms: 2, origin: { name: 'P', reason: 'state' } },
        { reason: 'props', keys: ['x'], ms: 4, origin: { name: 'P', reason: 'state' } },
      ],
      now,
    );
    const rs = [parent, child].map((e) => Object.assign({}, summarize(e, now), e));
    const groups = groupRenders(rs, now - 1000);
    const c = groups.find((g) => g.name === 'C')!;
    expect(c).toMatchObject({ ms: 6, avoidableMs: 2, timed: 2 });
    expect(groups.find((g) => g.name === 'P')!.impact).toMatchObject({ childMs: 6, unchangedMs: 2 });
  });

  it('started_child_time + 보고서: time·childMs·heaviestCommits 가 나온다', () => {
    render(<Parent />);
    act(() => bump());
    flushQueue();
    const sec = buildRenderSection(true, Date.now());
    const p = sec.components.find((c) => c.name === 'Parent')!;
    expect(p.time).toMatchObject({ totalMs: expect.any(Number), avgMs: expect.any(Number), avoidableMs: 0 });
    expect(p.startedRenders).toMatchObject({ childMs: expect.any(Number), unchangedMs: expect.any(Number) });
    expect(sec.heaviestCommits?.[0]).toMatchObject({ startedBy: 'Parent', components: 2 });
  });
});
