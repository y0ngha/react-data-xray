import { act } from 'react';
import { createContext, useContext, useState } from 'react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { cachedHookSites, hookSitesOf, requestHookSites } from '../hookPaths.js';
import { getFiber } from '../tree.js';
import type { Fiber } from '../types.js';

let root: ReturnType<typeof createRoot> | undefined;
const mount = async (node: React.ReactElement): Promise<Fiber> => {
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root!.render(node));
  return getFiber(el.firstElementChild!)!.return!;
};
afterEach(async () => {
  await act(async () => root?.unmount());
});

const useCounter = () => useState(0);
const dispatcherOf = (): Record<string, (...a: unknown[]) => unknown> => {
  const r = React as unknown as Record<string, { H?: unknown; ReactCurrentDispatcher?: { current: unknown } }>;
  const i = r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ?? r.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  return ('H' in i ? i.H : i.ReactCurrentDispatcher!.current) as Record<string, (...a: unknown[]) => unknown>;
};

describe('훅 호출 위치', () => {
  it('실패한 실행(언마운트된 fiber·던진 실행)은 캐시하지 않아 같은 타입의 다음 정상 실행이 구해진다 (PR3-2)', async () => {
    const Card = ({ item }: { item: { n: number } }) => {
      const [a] = useCounter();
      const [b] = useState(item.n);
      return <i>{a + b}</i>;
    };
    const fiber = await mount(<Card item={{ n: 1 }} />);
    expect(hookSitesOf({ ...fiber, memoizedProps: null })).toBeNull();
    expect(cachedHookSites(fiber)).toBeUndefined();
    // props 가 맞지 않아 둘째 훅 앞에서 던진다: 부분 결과만 있다
    expect(hookSitesOf({ ...fiber, memoizedProps: {} })).toHaveLength(1);
    expect(cachedHookSites(fiber)).toBeUndefined();
    expect(hookSitesOf(fiber)?.map((s) => s.path)).toEqual([['useCounter'], []]);
    expect(cachedHookSites(fiber)).toHaveLength(2);
  });

  it('use·useMemoCache 는 기록하지 않고, useMemoCache 는 배열을 돌려 준다 (PR3-3)', () => {
    const Compiled = () => {
      const $ = dispatcherOf().useMemoCache(2) as unknown[];
      dispatcherOf().use(null);
      const [n] = useState($[0] === Symbol.for('react.memo_cache_sentinel') ? 1 : 0);
      return <i>{n}</i>;
    };
    const fiber = { tag: 0, type: Compiled, memoizedProps: {}, return: null, _debugHookTypes: ['useState'] } as unknown as Fiber;
    expect(hookSitesOf(fiber)?.map((s) => s.type)).toEqual(['useState']);
    expect(cachedHookSites(fiber)).toHaveLength(1);
  });

  it('조상 Provider 값이 있어야 도는 컴포넌트도 끝까지 돌고 context 는 되돌린다 (ponytail PR3-3)', () => {
    const Ctx = createContext<{ items: number[] } | null>(null);
    const Needs = () => {
      const { items } = useContext(Ctx)!;
      const [n] = useState(items.length);
      return <i>{n}</i>;
    };
    const provider = { tag: 10, type: { _context: Ctx }, memoizedProps: { value: { items: [1] } }, return: null };
    const fiber = {
      tag: 0,
      type: Needs,
      memoizedProps: {},
      return: provider,
      _debugHookTypes: ['useContext', 'useState'],
    } as unknown as Fiber;
    expect(hookSitesOf(fiber)?.map((s) => s.type)).toEqual(['useContext', 'useState']);
    expect(cachedHookSites(fiber)).toHaveLength(2);
    expect(Reflect.get(Ctx, '_currentValue')).toBeNull();
  });

  it('displayName 이 있어도 커스텀 훅 경로가 나온다 (ponytail PR3-7)', async () => {
    const Inner = () => {
      const [n] = useCounter();
      return <i>{n}</i>;
    };
    Inner.displayName = 'Pretty';
    const fiber = await mount(<Inner />);
    expect(hookSitesOf(fiber)?.[0].path).toEqual(['useCounter']);
  });

  it('requestHookSites 는 유휴 큐에서 계산해 캐시에 둔다: 부른 자리에서는 컴포넌트를 돌리지 않는다 (계약 1)', async () => {
    let runs = 0;
    const Lazy = () => {
      runs++;
      const [n] = useCounter();
      return <i>{n}</i>;
    };
    const fiber = await mount(<Lazy />);
    const before = runs;
    expect(cachedHookSites(fiber)).toBeUndefined();
    requestHookSites(fiber);
    expect(runs).toBe(before);
    flushQueue();
    expect(runs).toBeGreaterThan(before);
    expect(cachedHookSites(fiber)?.[0].path).toEqual(['useCounter']);
    expect(cachedHookSites({ ...fiber, _debugHookTypes: null })).toBeNull();
  });
});
