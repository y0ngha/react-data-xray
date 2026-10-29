import { findRootFibers, getComponentName } from '../fiber/tree.js';
import { isComposite, type Fiber, type Hook } from '../fiber/types.js';
import { getMountStats } from '../render/mounts.js';
import { previewValue } from '../render/renderReason.js';
import type { RequestRecord } from './types.js';

export type RepeatCause = NonNullable<RequestRecord['repeatCause']>;

const biDetail = (en: string, ko: string): RepeatCause['detail'] => ({ en, ko });

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

// 한 step 에서 보는 fiber 수. 시간은 공용 큐가 본다.
const FIBERS_PER_STEP = 300;
// 요청이 나가기 이만큼 안에 다시 마운트된 것만 원인으로 본다(mounts.ts 의 REMOUNT_MS 와 같다).
const REMOUNT_WINDOW_MS = 5000;

const PENDING = Symbol('pending');

/**
 * 컴포넌트의 fiber 를 FIBERS_PER_STEP 개씩 훑어 바뀐 의존성을 찾는다. 부를 때마다 이어서 훑고, 다 훑고도 없으면 undefined, 더 훑을 게 있으면 PENDING.
 * shortcut: 가장 최근 렌더의 변경만 본다. 요청 뒤 한 번 더 렌더됐다면 놓칠 수 있다(유휴 큐가 곧 돌아 드물다).
 */
const depsSearch = (component: string) => {
  let stack: Fiber[] | undefined;
  return (): RepeatCause['detail'] | undefined | typeof PENDING => {
    stack ??= findRootFibers().reverse();
    for (let seen = 0; seen < FIBERS_PER_STEP; seen++) {
      const f = stack.pop();
      if (!f) return undefined;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
      if (!isComposite(f) || !f.alternate || getComponentName(f) !== component) continue;
      const c = changedDep(f);
      if (c)
        return biDetail(
          `dep #${c.dep + 1} changed (${previewValue(c.prev)} → ${previewValue(c.next)}), effect ${c.effect}`,
          `의존성 #${c.dep + 1} 변경 (${previewValue(c.prev)} → ${previewValue(c.next)}), ${c.effect}번째 effect`,
        );
    }
    return PENDING;
  };
};

const remountCauseOf = (record: RequestRecord, component: string): RepeatCause | undefined => {
  const remount = getMountStats(component).remounts.find(
    (r) => r.lastAt <= record.startedAt && record.startedAt - r.lastAt <= REMOUNT_WINDOW_MS,
  );
  if (!remount) return undefined;
  const parentEn = `parent <${remount.parent || 'root'}>`;
  const parentKo = `부모 <${remount.parent || '루트'}>`;
  return {
    kind: 'remount',
    detail: biDetail(
      remount.cause === 'type-changed'
        ? `<${component}> remount, ${parentEn} defines a component during render so the type changes every render (component defined during render)`
        : `<${component}> remount, ${parentEn} branch changed`,
      remount.cause === 'type-changed'
        ? `<${component}> 재마운트, ${parentKo} 가 렌더 중에 컴포넌트를 정의해 타입이 매번 바뀜(렌더 중 컴포넌트 정의)`
        : `<${component}> 재마운트, ${parentKo} 의 분기 변경`,
    ),
  };
};

/** 중복 요청이 다시 나간 이유를 찾는 일. 부를 때마다 조금씩 하고, 끝나면 이유(없으면 undefined)를 돌려준다. */
const repeatCauseSearch = (record: RequestRecord) => {
  let deps: ReturnType<typeof depsSearch> | undefined;
  return (): RepeatCause | undefined | typeof PENDING => {
    if (!record.duplicateOf) return undefined;
    if (record.strictModeReplay)
      return { kind: 'strict', detail: biDetail('StrictMode re-ran the effect during development', 'StrictMode 가 개발 중에 effect 를 다시 실행했습니다') };
    const component = record.component;
    if (!component) return undefined;
    const found = (deps ??= depsSearch(component))();
    if (found === PENDING) return PENDING;
    return found ? { kind: 'deps', detail: found } : remountCauseOf(record, component);
  };
};

/** record.repeatCause 를 채우는 큐 step. 끝나면 true. 앱 경로가 아니라 유휴 큐에서 부른다. */
export const repeatCauseStep = (record: RequestRecord): (() => boolean) => {
  const search = repeatCauseSearch(record);
  return () => {
    const cause = search();
    if (cause === PENDING) return false;
    record.repeatCause = cause;
    return true;
  };
};
