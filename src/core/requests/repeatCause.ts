import { findRootFibers, getComponentName, walkFibers } from '../fiber/tree.js';
import { isComposite, type Fiber, type Hook } from '../fiber/types.js';
import { getMountStats } from '../render/mounts.js';
import { previewValue } from '../render/renderReason.js';
import type { RequestRecord } from './types.js';

export type RepeatCause = NonNullable<RequestRecord['repeatCause']>;

const MAX_HOOKS = 200;

const depsOf = (state: unknown): unknown[] | undefined => {
  const effect = state as { create?: unknown; deps?: unknown } | null;
  return effect && typeof effect === 'object' && 'create' in effect && Array.isArray(effect.deps) ? effect.deps : undefined;
};

/** 이전 렌더(alternate)와 지금 렌더의 effect 훅을 같은 칸끼리 비교해 처음 바뀐 의존성을 찾는다. */
const changedDep = (fiber: Fiber): { effect: number; dep: number; prev: unknown; next: unknown } | undefined => {
  let cur = fiber.memoizedState as Hook | null;
  let prev = fiber.alternate?.memoizedState as Hook | null | undefined;
  for (let i = 0, effect = 0; cur && prev && i < MAX_HOOKS; i++, cur = cur.next, prev = prev.next) {
    const now = depsOf(cur.memoizedState);
    const before = depsOf(prev.memoizedState);
    if (!now || !before) continue;
    effect++;
    const dep = now.findIndex((v, j) => !Object.is(v, before[j]));
    if (dep >= 0) return { effect, dep, prev: before[dep], next: now[dep] };
  }
  return undefined;
};

// shortcut: 가장 최근 렌더의 변경만 본다. 요청 뒤 한 번 더 렌더됐다면 놓칠 수 있다(유휴 큐가 곧 돌아 드물다).
const depsCauseOf = (component: string): string | undefined => {
  let found: string | undefined;
  findRootFibers().forEach((root) =>
    walkFibers(root, (f) => {
      if (found) return false;
      if (!isComposite(f) || !f.alternate || getComponentName(f) !== component) return;
      const c = changedDep(f);
      if (c) found = `의존성 #${c.dep + 1} 변경 (${previewValue(c.prev)} → ${previewValue(c.next)}), ${c.effect}번째 effect`;
    }),
  );
  return found;
};

/** 중복 요청이 다시 나간 이유. 앱 경로가 아니라 유휴 큐에서 부른다. 알 수 없으면 undefined. */
export const repeatCauseOf = (record: RequestRecord): RepeatCause | undefined => {
  if (!record.duplicateOf) return undefined;
  if (record.strictModeReplay) return { kind: 'strict', detail: 'StrictMode 가 개발 중에 effect 를 다시 실행했습니다' };
  const component = record.component;
  if (!component) return undefined;
  const deps = depsCauseOf(component);
  if (deps) return { kind: 'deps', detail: deps };
  const remount = getMountStats(component).remounts[0];
  if (remount) return { kind: 'remount', detail: `<${component}> 재마운트, 부모 <${remount.parent || '루트'}> 의 분기 변경` };
  return undefined;
};
