import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildRenderSection } from '../../report/renderSection.js';
import { getMountStats } from '../mounts.js';
import { getRenderGroups, resetRenderStats, setRenderMonitoring } from '../monitor.js';

let bump: () => void = () => {};
const ROWS = 4;

// 열 정의를 렌더마다(v 가 바뀔 때마다) 새로 만들어 Cell 타입 정체가 바뀐다.
const InlineTable = () => {
  const [v, set] = useState(0);
  useEffect(() => {
    bump = () => set((n) => n + 1);
  }, []);
  const column = useMemo(() => {
    // oxlint-disable-next-line react/no-unstable-nested-components -- 재현하려는 안티패턴
    const Cell = () => <td>{v}</td>;
    return { Cell };
  }, [v]);
  return (
    <table>
      <tbody>
        <tr>
          {Array.from({ length: ROWS }, (_, i) => (
            <column.Cell key={i} />
          ))}
        </tr>
      </tbody>
    </table>
  );
};

// 모듈 수준 컴포넌트: key 만 바뀌어 재마운트(타입은 그대로)
const StableCell = () => <td>x</td>;
const KeyedTable = () => {
  const [v, set] = useState(0);
  useEffect(() => {
    bump = () => set((n) => n + 1);
  }, []);
  return (
    <table>
      <tbody>
        <tr>
          <StableCell key={v} />
        </tr>
      </tbody>
    </table>
  );
};

// 이름은 같고 본문이 다른 두 컴포넌트(객체 속성에 넣어 둘 다 이름이 Panel 이다)
const PanelA = { Panel: () => <td>a</td> }.Panel;
const PanelB = { Panel: () => <th>b</th> }.Panel;
const Swapper = () => {
  const [v, set] = useState(0);
  useEffect(() => {
    bump = () => set((n) => n + 1);
  }, []);
  const Panel = v % 2 === 0 ? PanelA : PanelB;
  return (
    <table>
      <tbody>
        <tr>
          {Array.from({ length: ROWS }, (_, i) => (
            <Panel key={i} />
          ))}
        </tr>
      </tbody>
    </table>
  );
};

beforeEach(() => setRenderMonitoring(true));
afterEach(() => {
  cleanup();
  resetRenderStats();
});

describe('타입이 바뀐 재마운트 (#33)', () => {
  it('inline_component_in_usememo: Cell 재마운트를 type-changed 로 집계하고 보고서에 처방이 나온다', () => {
    render(<InlineTable />);
    act(() => bump());
    act(() => bump());
    flushQueue();
    const stats = getMountStats('Cell');
    expect(stats.remounts).toEqual([{ parent: 'InlineTable', count: ROWS * 2, lastAt: expect.any(Number), cause: 'type-changed' }]);
    const c = buildRenderSection(true, Date.now()).components.find((x) => x.name === 'Cell')!;
    expect(c.mounts?.remounts[0].cause).toBe('type-changed');
    expect(c.advice.some((a) => a.includes('렌더 중에 컴포넌트를 정의하지 말고'))).toBe(true);
  });

  it('key 만 바뀐 재마운트는 type-changed 가 아니고 처방도 없다', () => {
    render(<KeyedTable />);
    act(() => bump());
    flushQueue();
    expect(getMountStats('StableCell').remounts).toEqual([{ parent: 'KeyedTable', count: 1, lastAt: expect.any(Number) }]);
    const g = getRenderGroups(Date.now(), 10_000).groups.find((x) => x.name === 'StableCell')!;
    expect(
      buildRenderSection(true, Date.now())
        .components.find((x) => x.name === 'StableCell')
        ?.advice.join(),
    ).not.toContain('컴포넌트를 정의하지');
    expect(g.mounts?.remounts[0]).not.toHaveProperty('cause');
  });

  it('이름은 같고 정의가 다른 두 컴포넌트가 바뀐 것은 type-changed 가 아니고 처방도 없다', () => {
    render(<Swapper />);
    act(() => bump());
    flushQueue();
    const { remounts } = getMountStats('Panel');
    expect(remounts.some((r) => r.cause === 'type-changed')).toBe(false);
    expect(
      buildRenderSection(true, Date.now())
        .components.find((x) => x.name === 'Panel')
        ?.advice.join(),
    ).not.toContain('컴포넌트를 정의하지');
  });
});
