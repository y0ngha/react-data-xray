import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fiber } from '../../fiber/types.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildRenderSection } from '../../report/renderSection.js';
import { getMountStats, recordMounts, resetMounts } from '../mounts.js';
import { getRenderGroups, resetRenderStats, setRenderMonitoring } from '../monitor.js';

let setN: (n: number) => void = () => {};
const Child = () => <i>c</i>;
const List = () => {
  const [n, set] = useState(0);
  useEffect(() => {
    setN = set;
  }, []);
  return <Child key={n} />;
};
const TwoPlaces = () => {
  const [n, set] = useState(0);
  useEffect(() => {
    setN = set;
  }, []);
  return (
    <>
      <Child key={n} />
      <Child key={`b${n}`} />
    </>
  );
};
const Item = () => <li>x</li>;
const Items = ({ n }: { n: number }) => (
  <ul>
    {Array.from({ length: n }, (_, i) => (
      <Item key={i} />
    ))}
  </ul>
);
const Chat = () => <Inner />;
const Inner = () => <b>chat</b>;
const Page = () => {
  const [loading, set] = useState(false);
  useEffect(() => {
    setN = (n) => set(n === 1);
  }, []);
  return loading ? <p>loading</p> : <Chat />;
};

beforeEach(() => setRenderMonitoring(true));
afterEach(() => {
  cleanup();
  resetRenderStats();
});

const stats = (name: string) => {
  flushQueue();
  return getMountStats(name);
};

describe('마운트 이력 (#6)', () => {
  it('key 가 두 번 바뀐 Child → 마운트 3, 언마운트 2, 재마운트 부모 List 2', () => {
    render(<List />);
    act(() => setN(1));
    act(() => setN(2));
    expect(stats('Child')).toEqual({ mounts: 3, unmounts: 2, remounts: [{ parent: 'List', count: 2, lastAt: expect.any(Number) }] });
  });

  it('list_not_remount: 목록 항목 5개는 마운트 5, 재마운트 없음', () => {
    render(<Items n={5} />);
    expect(stats('Item')).toEqual({ mounts: 5, unmounts: 0, remounts: [] });
  });

  it('목록에서 항목 하나가 빠졌다 새로 생겨도 형제가 남아 있으면 재마운트가 아니다', () => {
    const { rerender } = render(<Items n={5} />);
    rerender(<Items n={4} />);
    rerender(<Items n={5} />);
    expect(stats('Item').remounts).toEqual([]);
  });

  it('strict_mode: StrictMode 이중 마운트는 재마운트가 아니다', () => {
    render(
      <StrictMode>
        <List />
      </StrictMode>,
    );
    expect(stats('Child')).toMatchObject({ mounts: 1, unmounts: 0, remounts: [] });
  });

  it('부모의 로딩 분기로 서브트리째 돌아오면 분기를 바꾼 가장 가까운 부모를 가리킨다', () => {
    render(<Page />);
    act(() => setN(1));
    act(() => setN(0));
    expect(stats('Chat')).toEqual({ mounts: 2, unmounts: 1, remounts: [{ parent: 'Page', count: 1, lastAt: expect.any(Number) }] });
    expect(stats('Inner').remounts).toEqual([{ parent: 'Page', count: 1, lastAt: expect.any(Number) }]);
  });

  it('렌더 그룹과 보고서에 싣는다(언마운트가 있을 때만)', () => {
    render(<List />);
    act(() => setN(1));
    flushQueue();
    const g = getRenderGroups(Date.now(), 10_000).groups;
    expect(g.find((x) => x.name === 'Child')?.mounts).toMatchObject({ mounts: 2, unmounts: 1 });
    expect(g.find((x) => x.name === 'List')?.mounts).toBeUndefined();
    const c = buildRenderSection(true, Date.now()).components.find((x) => x.name === 'Child')!;
    expect(c.mounts?.remounts).toEqual([{ parent: 'List', count: 1, lastAt: expect.any(Number) }]);
  });

  it('같은 이름이 두 위치에서 렌더돼도 보고서 합산이 마운트를 두 번 세지 않는다', () => {
    render(<TwoPlaces />);
    act(() => setN(1));
    flushQueue();
    const comps = buildRenderSection(true, Date.now()).components.filter((x) => x.name === 'Child');
    expect(comps.length).toBe(2);
    const total = getMountStats('Child');
    expect(total.mounts).toBe(4);
    expect(comps.reduce((sum, c) => sum + (c.mounts?.mounts ?? 0), 0)).toBe(total.mounts);
  });
});

// 가짜 fiber 로 마운트 기록을 직접 넣는다.
const fake = (type: unknown, at?: string) =>
  ({ tag: 0, type, return: null, _debugSource: at ? { fileName: `/p/src/${at}`, lineNumber: 1 } : null }) as unknown as Fiber;
const Host = () => null;
const Row = () => null;

describe('마운트 이력: 위치·재마운트 시각·감시 전 인스턴스', () => {
  beforeEach(resetMounts);

  it('위치를 주면 그 위치의 마운트만 센다. 위치 없는 호출은 이름 전체 (계약 2)', () => {
    const host = fake(Host);
    const a = fake(Row, 'A.tsx');
    const b = fake(Row, 'B.tsx');
    recordMounts(
      [],
      [
        { fiber: a, parent: host, branch: host },
        { fiber: b, parent: host, branch: host },
      ],
      0,
    );
    recordMounts([{ fiber: a, parent: host }], [], 5);
    expect(getMountStats('Row')).toMatchObject({ mounts: 2, unmounts: 1 });
    expect(getMountStats('Row', 'src/A.tsx:1')).toMatchObject({ mounts: 1, unmounts: 1 });
    expect(getMountStats('Row', 'src/B.tsx:1')).toMatchObject({ mounts: 1, unmounts: 0 });
    expect(getMountStats('Row', 'src/C.tsx:1')).toEqual({ mounts: 0, unmounts: 0, remounts: [] });
  });

  it('재마운트 항목에 마지막 재마운트 시각이 있다 (계약 2)', () => {
    const host = fake(Host);
    const a = fake(Row);
    recordMounts([], [{ fiber: a, parent: host, branch: host }], 0);
    recordMounts([{ fiber: a, parent: host }], [{ fiber: a, parent: host, branch: host }], 10);
    recordMounts([{ fiber: a, parent: host }], [{ fiber: a, parent: host, branch: host }], 40);
    expect(getMountStats('Row').remounts).toEqual([{ parent: 'Host', count: 2, lastAt: 40 }]);
  });

  it('감시 전에 마운트된 목록 항목을 지웠다 다시 넣어도 재마운트가 아니다 (PR3-7)', () => {
    const host = fake(Host);
    const a = fake(Row);
    // 마운트는 못 봤다: 첫 기록이 언마운트
    recordMounts([{ fiber: a, parent: host }], [], 0);
    recordMounts([], [{ fiber: a, parent: host, branch: host }], 10);
    expect(getMountStats('Row')).toMatchObject({ mounts: 1, unmounts: 1, remounts: [] });
  });

  it('forwardRef 가 같은 render 를 나눠 써도(styled) 다른 컴포넌트로 바뀐 것은 type-changed 가 아니다 (PR3-1)', () => {
    const shared = (props: unknown, ref: unknown) => [props, ref];
    const wrap = () => ({ $$typeof: Symbol.for('react.forward_ref'), render: shared });
    const host = fake(Host);
    recordMounts([{ fiber: fake(wrap()), parent: host }], [], 0);
    recordMounts([], [{ fiber: fake(wrap()), parent: host, branch: host }], 5);
    expect(getMountStats('shared').remounts.some((r) => r.cause === 'type-changed')).toBe(false);
  });

  it('본문이 같은 HOC 결과도 JSX 위치가 다르면 type-changed 가 아니고, 같으면 type-changed 다 (ponytail PR3-2)', () => {
    const hoc = (name: string) => {
      const C = () => null;
      Object.defineProperty(C, 'name', { value: name });
      return C;
    };
    const host = fake(Host);
    const run = (at2: string) => {
      resetMounts();
      recordMounts([{ fiber: fake(hoc('Auth'), 'P.tsx'), parent: host }], [], 0);
      recordMounts([], [{ fiber: fake(hoc('Auth'), at2), parent: host, branch: host }], 5);
      return getMountStats('Auth').remounts[0]?.cause;
    };
    expect(run('Q.tsx')).toBeUndefined();
    expect(run('P.tsx')).toBe('type-changed');
  });
});
