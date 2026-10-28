import * as React from 'react';
import { resolveStack } from '../capture/sourceMap.js';
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

const renderFnOf = (fiber: Fiber): ((props: unknown, ref?: unknown) => unknown) | undefined => {
  const type = fiber.type as { render?: unknown } | ((p: unknown) => unknown) | null;
  const fn = typeof type === 'function' ? type : type?.render;
  return typeof fn === 'function' ? (fn as (props: unknown, ref?: unknown) => unknown) : undefined;
};

/**
 * 함수 컴포넌트를 가짜 dispatcher 로 한 번 더 돌려 훅 호출마다 호출 스택을 모은다(React DevTools 의 inspectHooks 와 같은 방식).
 * 렌더 중이 아닐 때만 부르므로 사용자가 렌더 항목을 열거나 보고서를 만들 때 한다. 던지면 거기까지 모은 것만 쓴다.
 */
const inspectHooks = (fiber: Fiber, expected: readonly string[]): HookSite[] | null => {
  const render = renderFnOf(fiber);
  const internals = internalsOf();
  if (!render || !internals) return null;
  const component = getComponentName(fiber);
  const sites: HookSite[] = [];
  const dispatcher = new Proxy({} as Dispatcher, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) => {
        sites.push(siteOf(name, new Error().stack ?? '', component));
        return fakeResult(name, args);
      },
  });
  const holder = 'H' in internals ? internals : internals.ReactCurrentDispatcher;
  const key = 'H' in internals ? 'H' : 'current';
  const box = holder as unknown as Record<string, Dispatcher | null>;
  const prev = box[key];
  const limit = Error.stackTraceLimit;
  box[key] = dispatcher;
  Error.stackTraceLimit = 100;
  try {
    render(fiber.memoizedProps, null);
  } catch {
    // 컴포넌트가 가짜 값에서 던져도 거기까지의 훅은 쓴다.
  } finally {
    box[key] = prev;
    Error.stackTraceLimit = limit;
  }
  // 칸 수가 아니라 호출 순서로 맞춘다. 종류가 다르면 엉뚱한 이름을 붙이지 않는다.
  return sites.every((s, i) => s.type === expected[i]) ? sites : null;
};

/** 컴포넌트 타입마다 한 번만 구한다(훅 호출 구조는 렌더마다 같다). */
export const hookSitesOf = (fiber: Fiber): HookSite[] | null => {
  const types = fiber._debugHookTypes;
  if (!types || !fiber.type || (typeof fiber.type !== 'object' && typeof fiber.type !== 'function')) return null;
  const key = fiber.type as object;
  if (!sitesByType.has(key)) sitesByType.set(key, inspectHooks(fiber, types));
  return sitesByType.get(key) ?? null;
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
