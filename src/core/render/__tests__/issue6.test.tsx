import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildRenderSection } from '../../report/renderSection.js';
import { getMountStats } from '../mounts.js';
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
    expect(stats('Child')).toEqual({ mounts: 3, unmounts: 2, remounts: [{ parent: 'List', count: 2 }] });
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
    expect(stats('Chat')).toEqual({ mounts: 2, unmounts: 1, remounts: [{ parent: 'Page', count: 1 }] });
    expect(stats('Inner').remounts).toEqual([{ parent: 'Page', count: 1 }]);
  });

  it('렌더 그룹과 보고서에 싣는다(언마운트가 있을 때만)', () => {
    render(<List />);
    act(() => setN(1));
    flushQueue();
    const g = getRenderGroups(Date.now(), 10_000).groups;
    expect(g.find((x) => x.name === 'Child')?.mounts).toMatchObject({ mounts: 2, unmounts: 1 });
    expect(g.find((x) => x.name === 'List')?.mounts).toBeUndefined();
    const c = buildRenderSection(true, Date.now()).components.find((x) => x.name === 'Child')!;
    expect(c.mounts?.remounts).toEqual([{ parent: 'List', count: 1 }]);
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
