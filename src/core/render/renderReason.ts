import type { Fiber, Hook } from '../fiber/types.js';
import { CLASS_COMPONENT } from '../fiber/types.js';
import type { RenderEvent } from './types.js';

const MAX_COMPARE_CHARS = 20_000;

export type ReasonResult = Pick<RenderEvent, 'reason' | 'keys'> & {
  /** 이 렌더를 일으킨 새 값들(네트워크 원인 판정용) */
  changed: unknown[];
};

/** effect 훅(매 렌더 새 effect 객체)과 useMemo·useCallback 훅([값, deps] 쌍)은 값 변경으로 보지 않는다. */
const isBookkeepingHookValue = (value: unknown): boolean =>
  (Array.isArray(value) && value.length === 2 && (value[1] === null || Array.isArray(value[1]))) ||
  (!!value && typeof value === 'object' && 'create' in value && 'tag' in value);

const hookPairs = (fiber: Fiber, prev: Fiber): Array<[Hook, Hook]> => {
  const pairs: Array<[Hook, Hook]> = [];
  let a = fiber.memoizedState as Hook | null;
  let b = prev.memoizedState as Hook | null;
  for (; a && b && typeof a === 'object' && 'next' in a; a = a.next, b = b.next) pairs.push([a, b]);
  return pairs;
};

/**
 * 값이 바뀐 state 훅들. useState·useReducer·useSyncExternalStore 처럼 queue 가 있는 훅과,
 * queue 없이 값만 들고 있는 useDeferredValue 같은 훅을 본다.
 */
export const changedState = (fiber: Fiber, prev: Fiber): unknown[] => {
  if (fiber.tag === CLASS_COMPONENT) return fiber.memoizedState !== prev.memoizedState ? [fiber.memoizedState] : [];
  return hookPairs(fiber, prev)
    .filter(([a, b]) => a.memoizedState !== b.memoizedState && (!!a.queue || !isBookkeepingHookValue(a.memoizedState)))
    .map(([a]) => a.memoizedState);
};

/** 값이 바뀐 context 들의 이름과 새 값 */
const changedContexts = (fiber: Fiber, prev: Fiber): Array<{ name: string; value: unknown }> => {
  const changed: Array<{ name: string; value: unknown }> = [];
  let b = prev.dependencies?.firstContext ?? null;
  for (let a = fiber.dependencies?.firstContext ?? null; a; a = a.next, b = b?.next ?? null) {
    if (!b || a.memoizedValue !== b.memoizedValue) changed.push({ name: a.context?.displayName || 'Context', value: a.memoizedValue });
  }
  return changed;
};

const NOT_PLAIN = new Error('not plain');

/** JSON 으로 그대로 비교할 수 있는 값만 통과시킨다. Map·Set·클래스 인스턴스는 JSON 에서 {} 가 돼 내용이 달라도 같아 보인다. */
const plainOnly = (_key: string, value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw NOT_PLAIN;
  }
  return value;
};

/** 참조는 다르지만 내용이 같은지. 크거나, 순환하거나, 평범한 객체·배열이 아닌 값은 다르다고 본다. */
export const sameContent = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    // Date 는 toJSON 으로 문자열이 된 뒤 replacer 에 들어오므로 그대로 비교된다.
    const sa = JSON.stringify(a, plainOnly);
    return sa.length <= MAX_COMPARE_CHARS && sa === JSON.stringify(b, plainOnly);
  } catch {
    return false;
  }
};

/** props 변경을 내용까지 보고 나눈다. children 은 부모가 렌더될 때마다 새 element 라 판정에서 뺀다. */
const propsReason = (props: Record<string, unknown>, prevProps: Record<string, unknown>, keys: string[]): ReasonResult => {
  const changed = keys.map((k) => props[k]);
  const compared = keys.filter((k) => k !== 'children');
  if (compared.length === 0) return { reason: 'props', keys, changed };
  const isCallback = (k: string) => typeof props[k] === 'function' && typeof prevProps[k] === 'function';
  const contentChanged = compared.some((k) => !isCallback(k) && !sameContent(props[k], prevProps[k]));
  if (contentChanged) return { reason: 'props', keys, changed };
  // 실제로 바뀐 내용 없이 새 참조만 내려왔다. 함수가 섞이면 useCallback, 아니면 useMemo 로 줄인다.
  return { reason: compared.some(isCallback) ? 'new-callback' : 'same-content', keys: compared, changed };
};

/** 이전 렌더(alternate)와 비교한 렌더 이유 */
export const reasonOf = (fiber: Fiber): ReasonResult => {
  const prev = fiber.alternate;
  if (!prev) return { reason: 'mount', changed: [fiber.memoizedProps] };
  const state = changedState(fiber, prev);
  if (state.length > 0) return { reason: 'state', changed: state };
  const contexts = changedContexts(fiber, prev);
  if (contexts.length > 0) return { reason: 'context', keys: contexts.map((c) => c.name), changed: contexts.map((c) => c.value) };
  const props = (fiber.memoizedProps ?? {}) as Record<string, unknown>;
  const prevProps = (prev.memoizedProps ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(props), ...Object.keys(prevProps)])).filter((k) => props[k] !== prevProps[k]);
  return keys.length === 0 ? { reason: 'parent', changed: [] } : propsReason(props, prevProps, keys);
};
