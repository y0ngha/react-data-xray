import * as React from 'react';
import { resolveStack } from '../capture/sourceMap.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { getComponentName, locationOfFrame } from './tree.js';
import type { Fiber } from './types.js';

/** 훅 호출 하나: 그 훅을 부른 커스텀 훅 경로(바깥부터)와 호출한 줄 */
export interface HookSite {
  type: string;
  path: string[];
  /** 호출 위치의 스택 줄(소스맵 변환용) */
  frame?: string;
}

interface Dispatcher {
  [hook: string]: unknown;
}
interface Internals {
  H?: Dispatcher | null;
  ReactCurrentDispatcher?: { current: Dispatcher | null };
}

const internalsOf = (): Internals | undefined => {
  const r = React as unknown as Record<string, Internals | undefined>;
  return r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ?? r.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
};

const noop = () => undefined;
const CONTEXT_PROVIDER = 10;
// React Compiler 가 첫 줄에서 캐시가 비었는지 보는 값
const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');
// 기록하지 않는 훅: 컴포넌트가 쓴 훅 목록(_debugHookTypes)에 없다.
const UNRECORDED = new Set(['use', 'useMemoCache']);
const run = (value: unknown): unknown => (typeof value === 'function' ? (value as () => unknown)() : value);

/** 가짜 dispatcher 가 훅마다 돌려주는 값: 컴포넌트가 끝까지 돌 만큼만 그럴듯하게 */
const fakeResult = (name: string, args: unknown[]): unknown => {
  switch (name) {
    case 'useState':
    case 'useReducer':
      return [name === 'useState' ? run(args[0]) : args.length > 2 ? (args[2] as (v: unknown) => unknown)(args[1]) : args[1], noop];
    case 'useRef':
      return { current: args[0] };
    case 'useMemo':
      return run(args[0]);
    case 'useCallback':
    case 'useDeferredValue':
      return args[0];
    case 'useContext':
      return Reflect.get((args[0] as object | undefined) ?? {}, '_currentValue');
    case 'use': {
      const arg = Object(args[0]) as { status?: string; value?: unknown };
      return arg.status === 'fulfilled' ? arg.value : Reflect.get(arg, '_currentValue');
    }
    case 'useMemoCache':
      return Array.from({ length: Number(args[0]) || 0 }, () => MEMO_CACHE_SENTINEL);
    case 'useActionState':
      return [args[1], noop, false];
    case 'useOptimistic':
      return [args[0], noop];
    case 'useSyncExternalStore':
      return (args[1] as () => unknown)();
    case 'useTransition':
      return [false, noop];
    case 'useId':
      return ':r:';
    default:
      return undefined;
  }
};

const FRAME_NAME = /^\s*(?:at (?:async )?(?:[\w$]+\.)?([\w$]+) [([]|at (?:async )?(?:[\w$]+\.)?([\w$]+)$|([\w$]*)@)/;
const nameOfFrame = (line: string): string | undefined => {
  const m = FRAME_NAME.exec(line);
  return m?.[1] ?? m?.[2] ?? m?.[3];
};
const IS_HOOK_NAME = /^use[A-Z0-9_]/;

/** 훅이 불린 시점의 스택에서 커스텀 훅 경로를 뽑는다. 첫 줄은 Error, 둘째는 가짜 dispatcher. */
const siteOf = (type: string, stack: string, component: string): HookSite => {
  // 가짜 dispatcher 줄 다음에 React 가 내보낸 훅 함수(useState 등) 줄이 한 번 더 나온다.
  const all = stack.split('\n').slice(2);
  const lines = nameOfFrame(all[0] ?? '') === type ? all.slice(1) : all;
  const top = lines.findIndex((l) => nameOfFrame(l) === component);
  const hookFrames = top < 0 ? [] : lines.slice(0, top);
  const path = hookFrames
    .map(nameOfFrame)
    .filter((n): n is string => !!n && IS_HOOK_NAME.test(n))
    .reverse();
  return { type, path, frame: hookFrames[0] };
};

const sitesByType = new WeakMap<object, HookSite[] | null>();
const failures = new WeakMap<object, number>();
const pending = new WeakSet<object>();
// 끝까지 못 돈 실행(언마운트·가짜 값에서 던짐)은 캐시하지 않고 다시 해 본다. 계속 안 되면 이만큼 뒤에 포기한다.
const MAX_FAILURES = 3;

const renderFnOf = (fiber: Fiber): ((props: unknown, ref?: unknown) => unknown) | undefined => {
  const type = fiber.type as { render?: unknown } | ((p: unknown) => unknown) | null;
  const fn = typeof type === 'function' ? type : type?.render;
  return typeof fn === 'function' ? (fn as (props: unknown, ref?: unknown) => unknown) : undefined;
};

/** 조상 Provider 의 값을 context 에 잠시 넣는다(React DevTools 의 setupContexts). 되돌리는 함수를 돌려준다. */
const provideContexts = (fiber: Fiber): (() => void) => {
  const saved = new Map<object, unknown>();
  for (let f = fiber.return; f; f = f.return) {
    if (f.tag !== CONTEXT_PROVIDER || !f.type) continue;
    const context = (Reflect.get(f.type as object, '_context') ?? f.type) as object;
    if (saved.has(context)) continue;
    saved.set(context, Reflect.get(context, '_currentValue'));
    Reflect.set(context, '_currentValue', (f.memoizedProps as { value?: unknown } | null)?.value);
  }
  return () => saved.forEach((value, context) => Reflect.set(context, '_currentValue', value));
};

/**
 * 함수 컴포넌트를 가짜 dispatcher 로 한 번 더 돌려 훅 호출마다 호출 스택을 모은다(React DevTools 의 inspectHooks 와 같은 방식).
 * 렌더 중이 아닐 때만 부른다. 던지면 거기까지 모은 것만 쓴다(complete 가 false).
 */
const inspectHooks = (fiber: Fiber, expected: readonly string[]): { sites: HookSite[] | null; complete: boolean } => {
  const render = renderFnOf(fiber);
  const internals = internalsOf();
  if (!render || !internals) return { sites: null, complete: false };
  // 함수 이름이 스택에 나온다. displayName 과 다를 수 있다.
  const component = render.name || getComponentName(fiber);
  const sites: HookSite[] = [];
  const dispatcher = new Proxy({} as Dispatcher, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) => {
        if (!UNRECORDED.has(name)) sites.push(siteOf(name, new Error().stack ?? '', component));
        return fakeResult(name, args);
      },
  });
  const holder = 'H' in internals ? internals : internals.ReactCurrentDispatcher;
  const key = 'H' in internals ? 'H' : 'current';
  const box = holder as unknown as Record<string, Dispatcher | null>;
  const prev = box[key];
  const limit = Error.stackTraceLimit;
  const restoreContexts = provideContexts(fiber);
  box[key] = dispatcher;
  Error.stackTraceLimit = 100;
  let threw = false;
  try {
    render(fiber.memoizedProps, null);
  } catch {
    threw = true;
  } finally {
    box[key] = prev;
    Error.stackTraceLimit = limit;
    restoreContexts();
  }
  // 칸 수가 아니라 호출 순서로 맞춘다. 종류가 다르면 엉뚱한 이름을 붙이지 않는다.
  if (!sites.every((s, i) => s.type === expected[i])) return { sites: null, complete: false };
  return { sites, complete: !threw && sites.length === expected.length };
};

const keyOf = (fiber: Fiber): object | undefined =>
  fiber._debugHookTypes && fiber.type && (typeof fiber.type === 'object' || typeof fiber.type === 'function')
    ? (fiber.type as object)
    : undefined;

/** 캐시에 있는 것만 읽는다. undefined 는 아직 모름, null 은 구할 수 없음. */
export const cachedHookSites = (fiber: Fiber): HookSite[] | null | undefined => {
  const key = keyOf(fiber);
  return key ? sitesByType.get(key) : null;
};

/** 훅 호출 구조는 렌더마다 같으므로 컴포넌트 타입마다 한 번 구한다. 실패·부분 결과는 캐시하지 않는다(몇 번 되풀이해도 안 되면 포기). */
export const hookSitesOf = (fiber: Fiber): HookSite[] | null => {
  const key = keyOf(fiber);
  if (!key) return null;
  const hit = sitesByType.get(key);
  if (hit !== undefined) return hit;
  if (fiber.memoizedProps == null) return null; // 언마운트된 fiber 는 props 가 비어 있다
  const { sites, complete } = inspectHooks(fiber, fiber._debugHookTypes!);
  if (complete) sitesByType.set(key, sites);
  else {
    const n = (failures.get(key) ?? 0) + 1;
    failures.set(key, n);
    if (n >= MAX_FAILURES) sitesByType.set(key, null);
  }
  return sites;
};

/** 유휴 큐에서 hookSitesOf 를 돌려 결과를 캐시에 둔다. 렌더 탭 같은 주기 화면은 이걸 부르고 cachedHookSites 만 읽는다. */
export const requestHookSites = (fiber: Fiber): void => {
  const key = keyOf(fiber);
  if (!key || sitesByType.has(key) || pending.has(key)) return;
  pending.add(key);
  enqueue(() => {
    try {
      hookSitesOf(fiber);
    } finally {
      pending.delete(key);
    }
    return true;
  });
};

// 소스맵으로 풀어낸 호출 위치. 풀기는 비동기라 처음엔 없고, 다음 요약부터 붙는다.
const resolved = new Map<string, string | null>();

/** 호출 줄의 원본 위치("src/x.ts:12"). 풀리지 않았으면 undefined 이고 풀기를 시작한다. */
export const resolvedLocation = (frame: string | undefined): string | undefined => {
  if (!frame) return undefined;
  const hit = resolved.get(frame);
  if (hit !== undefined) return hit ?? undefined;
  resolved.set(frame, null);
  void resolveStack(frame.trim()).then(
    (out) => out !== frame.trim() && resolved.set(frame, locationOfFrame(out) ?? null),
    () => undefined,
  );
  return undefined;
};
