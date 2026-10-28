import type { Fiber, Hook } from '../fiber/types.js';
import { CLASS_COMPONENT } from '../fiber/types.js';
import type { HookChange, RenderEvent } from './types.js';

const MAX_COMPARE_CHARS = 20_000;

export type ReasonResult = Pick<RenderEvent, 'reason' | 'keys' | 'hooks'> & {
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

// 훅 목록(_debugHookTypes)과 훅 연결 리스트의 칸은 1:1 이 아니다. 칸을 만들지 않는 훅과,
const NO_HOOK_NODE = new Set(['useContext', 'useDebugValue', 'use']);
// 한 번 부르면 칸을 둘 만드는 훅(안에서 effect·ref·state 를 하나 더 쓴다). useDeferredValue 는 React 18 에서만 둘이다.
const TWO_NODES: ReadonlySet<string> = new Set(['useSyncExternalStore', 'useTransition']);
const TWO_NODES_REACT_18: ReadonlySet<string> = new Set([...TWO_NODES, 'useDeferredValue']);
const PREVIEW_CHARS = 40;

const PREVIEW_ITEMS = 3;

const cut = (text: string): string => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text);

// 객체 안의 Map·Set 은 JSON 에서 {} 가 돼 내용이 달라도 같아 보이므로 종류와 크기로 바꾼다.
const kindOf = (_key: string, v: unknown): unknown => (v instanceof Map ? `Map(${v.size})` : v instanceof Set ? `Set(${v.size})` : v);

const json = (v: unknown): string => (typeof v === 'function' ? 'ƒ' : (JSON.stringify(v, kindOf) ?? String(v)));

/** 클래스 인스턴스의 JSON. toJSON 이 undefined 를 주거나 순환하면 {…} */
const instanceJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, kindOf) ?? '{…}';
  } catch {
    return '{…}';
  }
};

/** 앞 n 개만 꺼낸다(큰 Map·Set 을 통째로 복사하지 않는다). */
const take = <T>(items: Iterable<T>, n: number): T[] => {
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= n) break;
    out.push(item);
  }
  return out;
};

/** 값 미리보기: 숫자·문자열은 그대로, Map·Set·Date·클래스 인스턴스는 종류(와 크기)를 붙이고, 나머지는 짧은 JSON(못 하면 종류만) */
export const previewValue = (value: unknown): string => {
  if (typeof value === 'function') return 'ƒ';
  try {
    if (value instanceof Map) {
      const head = take(value, PREVIEW_ITEMS).map(([k, v]) => `${json(k)} => ${json(v)}`);
      return cut(`Map(${value.size}) {${head.join(', ')}${value.size > PREVIEW_ITEMS ? ', …' : ''}}`);
    }
    if (value instanceof Set) {
      const head = take(value, PREVIEW_ITEMS).map(json);
      return cut(`Set(${value.size}) [${head.join(', ')}${value.size > PREVIEW_ITEMS ? ', …' : ''}]`);
    }
    if (value instanceof Date) return `Date(${Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString()})`;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      const name = proto && proto !== Object.prototype ? proto.constructor?.name : undefined;
      if (name) return cut(`${name} ${instanceJson(value)}`);
    }
    return cut(json(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
};

interface HookCall {
  type: string;
  /** 이 컴포넌트가 이 훅을 부른 순서(1부터, useContext 도 센다). 코드를 위에서부터 읽으며 세는 번호다. */
  call: number;
}

const expandCalls = (types: readonly string[], twoNodes: ReadonlySet<string>): HookCall[] =>
  types.flatMap((type, i) => {
    if (NO_HOOK_NODE.has(type)) return [];
    const call = { type, call: i + 1 };
    return twoNodes.has(type) ? [call, call] : [call];
  });

/** 연결 리스트의 칸마다, 그 칸을 만든 훅 호출. dev 빌드가 기록하지 않았거나 개수가 안 맞으면 없다(엉뚱한 이름을 붙이지 않게). */
const hookCallsOf = (fiber: Fiber, nodeCount: number): readonly HookCall[] | undefined => {
  const types = fiber._debugHookTypes;
  if (!types) return undefined;
  return [expandCalls(types, TWO_NODES), expandCalls(types, TWO_NODES_REACT_18)].find((calls) => calls.length === nodeCount);
};

/**
 * 값이 바뀐 state 훅들. useState·useReducer·useSyncExternalStore 처럼 queue 가 있는 훅과,
 * queue 없이 값만 들고 있는 useDeferredValue 같은 훅을 본다.
 */
export const changedHooks = (fiber: Fiber, prev: Fiber): Array<HookChange & { value: unknown }> => {
  if (fiber.tag === CLASS_COMPONENT) {
    return fiber.memoizedState !== prev.memoizedState
      ? [
          {
            index: 1,
            type: 'this.state',
            from: previewValue(prev.memoizedState),
            to: previewValue(fiber.memoizedState),
            value: fiber.memoizedState,
          },
        ]
      : [];
  }
  const pairs = hookPairs(fiber, prev);
  const calls = hookCallsOf(fiber, pairs.length);
  return pairs.flatMap(([a, b], i) =>
    a.memoizedState !== b.memoizedState && (!!a.queue || !isBookkeepingHookValue(a.memoizedState))
      ? [
          {
            index: calls?.[i]?.call ?? i + 1,
            type: calls?.[i]?.type,
            from: previewValue(b.memoizedState),
            to: previewValue(a.memoizedState),
            value: a.memoizedState,
          },
        ]
      : [],
  );
};

export const changedState = (fiber: Fiber, prev: Fiber): unknown[] => changedHooks(fiber, prev).map((h) => h.value);

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
  const hooks = changedHooks(fiber, prev);
  if (hooks.length > 0) return { reason: 'state', changed: hooks.map((h) => h.value), hooks: hooks.map(({ value: _value, ...h }) => h) };
  const contexts = changedContexts(fiber, prev);
  if (contexts.length > 0) return { reason: 'context', keys: contexts.map((c) => c.name), changed: contexts.map((c) => c.value) };
  const props = (fiber.memoizedProps ?? {}) as Record<string, unknown>;
  const prevProps = (prev.memoizedProps ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(props), ...Object.keys(prevProps)])).filter((k) => props[k] !== prevProps[k]);
  return keys.length === 0 ? { reason: 'parent', changed: [] } : propsReason(props, prevProps, keys);
};
