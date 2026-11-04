import type { Fiber, Hook } from '../fiber/types.js';
import { previewValue } from './renderReason.js';

const MAX_HOOKS = 200;

const depsOf = (state: unknown): unknown[] | undefined => {
  const effect = state as { create?: unknown; deps?: unknown } | null;
  return effect && typeof effect === 'object' && 'create' in effect && Array.isArray(effect.deps) ? effect.deps : undefined;
};

/**
 * commit 사본(snap)의 effect 훅을 이전 렌더(snap.alternate)와 같은 칸끼리 비교해 처음 바뀐 의존성을 글로 돌려준다.
 * 마운트(이전 렌더 없음)나 바뀐 의존성이 없으면 undefined. 사본은 commit 시점 값이라 뒤 렌더에 덮이지 않는다.
 */
export const changedEffectDep = (snap: Fiber): string | undefined => {
  let cur = snap.memoizedState as Hook | null;
  let prev = snap.alternate?.memoizedState as Hook | null | undefined;
  for (let i = 0, effect = 0; cur && prev && i < MAX_HOOKS; i++, cur = cur.next, prev = prev.next) {
    const now = depsOf(cur.memoizedState);
    const before = depsOf(prev.memoizedState);
    if (!now || !before) continue;
    effect++;
    const dep = now.findIndex((v, j) => !Object.is(v, before[j]));
    if (dep >= 0) return `dep #${dep + 1} changed (${previewValue(before[dep])} → ${previewValue(now[dep])}), effect ${effect}`;
  }
  return undefined;
};
