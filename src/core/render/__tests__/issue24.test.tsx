import { act, cleanup, render } from '@testing-library/react';
import { memo, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderAdvice } from '../advice.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildRenderSection } from '../../report/renderSection.js';
import { getRenderGroups, resetRenderStats, setRenderMonitoring } from '../monitor.js';

let bump: () => void = () => {};
const Parent = ({ children }: { children: (n: number) => React.ReactNode }) => {
  const [n, setN] = useState(0);
  useEffect(() => {
    bump = () => setN((x) => x + 1);
  }, []);
  return <div>{children(n)}</div>;
};

const Stable = memo(function Stable({ label }: { label: string }) {
  return <i>{label}</i>;
});
const Clicky = memo(function Clicky({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick}>x</button>;
});
const Compared = memo(
  function Compared({ label }: { label: string }) {
    return <u>{label}</u>;
  },
  (a, b) => a.label === b.label,
);

beforeEach(() => setRenderMonitoring(true));
afterEach(() => {
  cleanup();
  resetRenderStats();
});

const group = (name: string) => {
  flushQueue();
  return getRenderGroups(Date.now(), 10_000).groups.find((g) => g.name === name)!;
};

describe('memo 건너뜀 횟수 (#24)', () => {
  it('skip_counted: 부모 3회 렌더, prop 불변 → skipped 3, rendered 0', () => {
    render(<Parent>{() => <Stable label="a" />}</Parent>);
    for (let i = 0; i < 3; i++) act(() => bump());
    expect(group('Stable').memo).toEqual({ skipped: 3, rendered: 0, neverSkippedProps: [] });
  });

  it('compare 를 준 memo 도 건너뜀으로 센다', () => {
    render(<Parent>{() => <Compared label="a" />}</Parent>);
    for (let i = 0; i < 2; i++) act(() => bump());
    expect(group('Compared').memo).toMatchObject({ skipped: 2, rendered: 0 });
  });

  it('never_skipped: 매번 새 콜백 → neverSkippedProps [onClick], 보고서·조언에도 나온다', () => {
    render(<Parent>{() => <Clicky onClick={() => undefined} />}</Parent>);
    for (let i = 0; i < 3; i++) act(() => bump());
    const g = group('Clicky');
    expect(g.memo).toEqual({ skipped: 0, rendered: 3, neverSkippedProps: ['onClick'] });
    expect(renderAdvice(g)[0]).toContain('props.onClick');
    const c = buildRenderSection(true, Date.now()).components.find((x) => x.name === 'Clicky')!;
    expect(c.memo).toEqual({ skipped: 0, rendered: 3, neverSkippedProps: ['onClick'] });
  });

  it('memo 가 아니면 memo 정보가 없다', () => {
    render(<Parent>{() => <span />}</Parent>);
    act(() => bump());
    expect(group('Parent').memo).toBeUndefined();
  });
});
