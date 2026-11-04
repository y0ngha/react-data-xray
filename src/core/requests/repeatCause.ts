import { findRootFibers, getComponentName } from '../fiber/tree.js';
import { isComposite, type Fiber, type Hook } from '../fiber/types.js';
import { getMountStats } from '../render/mounts.js';
import { lastCommitBefore, lastRenderAt } from '../render/renderTimes.js';
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

// 한 step 에서 보는 fiber 수. 시간은 공용 큐가 본다.
const FIBERS_PER_STEP = 300;
// 요청이 나가기 이만큼 안에 다시 마운트된 것만 원인으로 본다(mounts.ts 의 REMOUNT_MS 와 같다).
const REMOUNT_WINDOW_MS = 5000;

const PENDING = Symbol('pending');
// 이 컴포넌트의 fiber 가 요청 뒤에 다시 렌더돼, 지금 fiber 의 의존성 비교로는 요청을 보낸 렌더를 알 수 없다.
const STALE = Symbol('stale');

/**
 * 컴포넌트의 fiber 를 FIBERS_PER_STEP 개씩 훑어 바뀐 의존성을 찾는다. 부를 때마다 이어서 훑고, 더 훑을 게 있으면 PENDING.
 * 다 훑고도 없을 때 요청 뒤에 다시 렌더된 fiber 를 건너뛰었으면 STALE, 아니면 undefined.
 * 요청 뒤에 렌더된 fiber 의 alternate 비교는 요청을 보낸 렌더가 아니라 그 뒤 렌더의 변경이라(다른 effect 의 함수 의존성 등) 쓰지 않는다.
 * shortcut: 어느 effect 가 요청을 보냈는지는 모른다. 요청을 보낸 렌더에서 처음 바뀐 의존성을 원인으로 본다.
 * 렌더 감시가 꺼져 렌더 시각이 없으면 가장 최근 렌더의 변경을 그대로 쓴다.
 */
const depsSearch = (component: string, startedAt: number) => {
  let stack: Fiber[] | undefined;
  let stale = false;
  return (): string | undefined | typeof PENDING | typeof STALE => {
    stack ??= findRootFibers().reverse();
    for (let seen = 0; seen < FIBERS_PER_STEP; seen++) {
      const f = stack.pop();
      if (!f) return stale ? STALE : undefined;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
      if (!isComposite(f) || !f.alternate || getComponentName(f) !== component) continue;
      const renderedAt = lastRenderAt(f);
      if (renderedAt !== undefined && renderedAt > startedAt) {
        stale = true;
        continue;
      }
      const c = changedDep(f);
      if (c) return `dep #${c.dep + 1} changed (${previewValue(c.prev)} → ${previewValue(c.next)}), effect ${c.effect}`;
    }
    return PENDING;
  };
};

/**
 * 요청 시작 전 windowStart 이후(포함)에 다시 마운트됐으면 그 이유. windowStart 를 요청 직전 commit 으로 주면
 * 그 commit 이 다시 마운트한 것이라, 의존성과 상관없이 마운트 effect 가 다시 돈 것이다.
 */
const remountCauseOf = (record: RequestRecord, component: string, windowStart: number): RepeatCause | undefined => {
  const remount = getMountStats(component).remounts.find((r) => r.lastAt <= record.startedAt && r.lastAt >= windowStart);
  if (!remount) return undefined;
  const parent = `parent <${remount.parent || 'root'}>`;
  return {
    kind: 'remount',
    detail:
      remount.cause === 'type-changed'
        ? `<${component}> remount, ${parent} defines a component during render so the type changes every render (component defined during render)`
        : `<${component}> remount, ${parent} branch changed`,
  };
};

/**
 * 중복 요청이 다시 나간 이유를 찾는 일. 부를 때마다 조금씩 하고, 끝나면 이유(없으면 undefined)를 돌려준다.
 * 1) 요청 직전 commit 이 이 컴포넌트를 다시 마운트했으면 remount(마운트 직후 effect 는 의존성 비교 대상이 아니다).
 * 2) 요청을 보낸 렌더에서 바뀐 의존성이 있으면 deps.
 * 3) 의존성을 확인할 수 없었으면(요청 뒤에 다시 렌더) 비워 둔다. 아니면 5초 안의 재마운트(비동기로 늦게 보낸 마운트 effect).
 */
const repeatCauseSearch = (record: RequestRecord) => {
  let deps: ReturnType<typeof depsSearch> | undefined;
  return (): RepeatCause | undefined | typeof PENDING => {
    if (!record.duplicateOf) return undefined;
    if (record.strictModeReplay) return { kind: 'strict', detail: 'StrictMode re-ran the effect during development' };
    const component = record.component;
    if (!component) return undefined;
    if (!deps) {
      // 요청 직전 commit 의 effect 가 요청을 보냈다고 본다.
      const commitAt = lastCommitBefore(record.startedAt);
      const remount = commitAt === undefined ? undefined : remountCauseOf(record, component, commitAt);
      if (remount) return remount;
      deps = depsSearch(component, record.startedAt);
    }
    const found = deps();
    if (found === PENDING) return PENDING;
    if (found === STALE) return undefined;
    return found ? { kind: 'deps', detail: found } : remountCauseOf(record, component, record.startedAt - REMOUNT_WINDOW_MS);
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
