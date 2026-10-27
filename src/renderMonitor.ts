import { getOrigin, type RequestRecord } from './registry.js';

// React DevTools 와 같은 전역 훅의 commit 이벤트로 컴포넌트별 렌더 횟수를 센다.
// react-dom 은 로드될 때 이 훅에 자신을 등록하므로, 이 모듈은 react-dom 보다 먼저 평가돼야 한다.

interface Fiber {
  tag: number;
  type: unknown;
  memoizedProps: unknown;
  memoizedState: unknown;
  /** dev 빌드가 기록하는, 자식을 뺀 이 컴포넌트 자신의 마지막 렌더 시간(ms) */
  selfBaseDuration?: number;
  /** 이 컴포넌트가 읽은 context 목록(React 18, 19) */
  dependencies?: { firstContext: ContextDependency | null } | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  flags: number;
}

interface ContextDependency {
  context: { displayName?: string; Provider?: unknown } | null;
  memoizedValue: unknown;
  next: ContextDependency | null;
}

interface DevtoolsHook {
  renderers: Map<number, unknown>;
  supportsFiber: boolean;
  inject: (renderer: unknown) => number;
  onCommitFiberRoot: (id: number, root: { current: Fiber }, ...rest: unknown[]) => void;
  onCommitFiberUnmount: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  checkDCE?: () => void;
}

/**
 * 렌더된 이유. same-content, new-callback, parent 는 줄일 수 있는 렌더다.
 * - same-content: 바뀐 props 가 참조만 새롭고 내용은 같다 → useMemo, 구조적 공유 후보
 * - new-callback: 바뀐 props 가 렌더마다 새로 만든 함수다(나머지는 내용이 같다) → useCallback 후보
 * - parent: props·state·context 가 그대로인데 렌더됐다(부모가 렌더됨) → React.memo 후보
 * - context: 읽고 있는 context 값이 바뀌었다 → context 나누기, value useMemo, selector
 */
export type RenderReason = 'mount' | 'state' | 'context' | 'props' | 'same-content' | 'new-callback' | 'parent';

export const AVOIDABLE_REASONS: readonly RenderReason[] = ['same-content', 'new-callback', 'parent'];

/**
 * 이 렌더가 네트워크 응답 때문인지. 렌더는 네트워크와 무관할 수 있으므로 근거가 있을 때만 붙인다.
 * - direct: 새로 바뀐 state·props 안에 최근(3초 안) 도착한 응답의 객체가 있다
 * - parent: 같은 commit 에서 네트워크 응답 때문에 렌더된 조상을 따라 렌더됐다
 */
export interface NetworkCause {
  record: RequestRecord;
  via: 'direct' | 'parent';
}

export interface RenderEvent {
  time: number;
  reason: RenderReason;
  cause?: NetworkCause;
  /** 자기 자신의 렌더 시간(ms). dev 빌드가 기록하지 않으면 없다. */
  ms?: number;
  /** props·context 때문이면 바뀐 props 이름 또는 context 이름 */
  keys?: string[];
}

export interface RenderEntry {
  name: string;
  /** 렌더 기록(최근 것만 남긴다) */
  events: RenderEvent[];
  fiber: Fiber;
  memoized: boolean;
}

export interface RenderSummary {
  recent: number;
  last: number;
  /** 최근 10초 자기 자신의 렌더 시간 합(ms) */
  ms: number;
  reasons: Record<RenderReason, number>;
  /** 줄일 수 있는 렌더(same-content + new-callback + parent) */
  avoidable: number;
  /** same-content 로 렌더를 일으킨 props 이름 */
  sameContentKeys: string[];
  /** new-callback 으로 렌더를 일으킨 props 이름 */
  callbackKeys: string[];
  /** context 로 렌더를 일으킨 context 이름 */
  contextKeys: string[];
  /** 이미 React.memo 로 감싼 컴포넌트인지(그러면 React.memo 를 권하지 않는다) */
  memoized: boolean;
  /** 네트워크 응답 때문에 생긴 렌더 수(나머지는 네트워크와 무관) */
  network: number;
  /** 원인 요청(엔드포인트별 최신 요청)과 직접·부모 경유 횟수 */
  causes: Array<{ record: RequestRecord; direct: number; parent: number }>;
}

const COMPOSITE_TAGS = new Set([0, 1, 11, 15]);
const SIMPLE_MEMO = 15;
const MEMO = 14;
// React 18, 19 의 PerformedWork 플래그. 이번 commit 에서 실제로 렌더 함수를 실행했다는 뜻이다.
const PERFORMED_WORK = 1;
const WINDOW_MS = 10_000;

export interface Commit {
  time: number;
  /** 이 commit 에서 렌더된 컴포넌트 수 */
  count: number;
}

const MAX_COMMITS = 500;
const commits: Commit[] = [];
const entries = new WeakMap<Fiber, RenderEntry>();
const ignoredTypes = new Set<unknown>();
const commitListeners = new Set<() => void>();
const active = new Set<RenderEntry>();
let enabled = false;

const nameOf = (type: unknown): string => {
  const t = type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return t?.displayName || t?.name || t?.render?.name || t?.type?.name || 'Anonymous';
};

interface Hook {
  memoizedState: unknown;
  queue: unknown;
  next: Hook | null;
}

/** effect 훅(매 렌더 새 effect 객체)과 useMemo·useCallback 훅([값, deps] 쌍)은 값 변경으로 보지 않는다. */
const isBookkeepingHookValue = (value: unknown): boolean =>
  (Array.isArray(value) && value.length === 2 && (value[1] === null || Array.isArray(value[1]))) ||
  (!!value && typeof value === 'object' && 'create' in value && 'tag' in value);

/**
 * 값이 바뀐 state 훅들. useState·useReducer·useSyncExternalStore 처럼 queue 가 있는 훅과,
 * queue 없이 값만 들고 있는 useDeferredValue 같은 훅을 본다.
 */
const changedState = (fiber: Fiber, prev: Fiber): unknown[] => {
  if (fiber.tag === 1) return fiber.memoizedState !== prev.memoizedState ? [fiber.memoizedState] : [];
  const changed: unknown[] = [];
  let a = fiber.memoizedState as Hook | null;
  let b = prev.memoizedState as Hook | null;
  for (; a && b && typeof a === 'object' && 'next' in a; a = a.next, b = b.next) {
    if (a.memoizedState === b.memoizedState) continue;
    if (a.queue || !isBookkeepingHookValue(a.memoizedState)) changed.push(a.memoizedState);
  }
  return changed;
};

/** 값이 바뀐 context 들의 이름과 새 값 */
const changedContexts = (fiber: Fiber, prev: Fiber): Array<{ name: string; value: unknown }> => {
  const changed: Array<{ name: string; value: unknown }> = [];
  let a = fiber.dependencies?.firstContext ?? null;
  let b = prev.dependencies?.firstContext ?? null;
  for (; a; a = a.next, b = b?.next ?? null) {
    if (!b || a.memoizedValue !== b.memoizedValue) changed.push({ name: a.context?.displayName || 'Context', value: a.memoizedValue });
  }
  return changed;
};

// 응답이 도착하고 이 시간 안에 렌더됐을 때만 그 응답 때문이라고 본다.
// 예전 응답 데이터를 담은 채 다른 이유로 state 를 바꾼 경우(setState({...prev, filter}))를 걸러 낸다.
const NETWORK_CAUSE_WINDOW_MS = 3000;
const MAX_CAUSE_DEPTH = 3;

/** 값 안에서 최근에 도착한 응답의 객체를 찾는다. */
const findRecentResponse = (values: unknown[], now: number): RequestRecord | undefined => {
  const seen = new WeakSet<object>();
  let found: RequestRecord | undefined;
  const walk = (value: unknown, depth: number) => {
    if (found || value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) {
      const arrived = origin.record.startedAt + origin.record.durationMs;
      if (now >= arrived && now - arrived <= NETWORK_CAUSE_WINDOW_MS) found = origin.record;
      return;
    }
    // React element 는 _owner 로 끝없이 퍼지므로 따라가지 않는다.
    if (depth >= MAX_CAUSE_DEPTH || (value as { $$typeof?: unknown }).$$typeof) return;
    const children = Array.isArray(value) ? value.slice(0, 50) : Object.values(value).slice(0, 50);
    for (const child of children) walk(child, depth + 1);
  };
  for (const v of values) walk(v, 0);
  return found;
};

const MAX_COMPARE_CHARS = 20_000;

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
const sameContent = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    // Date 는 toJSON 으로 문자열이 된 뒤 replacer 에 들어오므로 그대로 비교된다.
    const sa = JSON.stringify(a, plainOnly);
    return sa.length <= MAX_COMPARE_CHARS && sa === JSON.stringify(b, plainOnly);
  } catch {
    return false;
  }
};

type ReasonResult = Pick<RenderEvent, 'reason' | 'keys'> & { changed: unknown[] };

/** 렌더 이유와, 그 이유가 된 새 값들(네트워크 원인 판정용) */
const reasonOf = (fiber: Fiber, isNew: boolean): ReasonResult => {
  const prev = fiber.alternate;
  if (!prev || isNew) return { reason: 'mount', changed: [fiber.memoizedProps] };
  const state = changedState(fiber, prev);
  if (state.length > 0) return { reason: 'state', changed: state };
  const contexts = changedContexts(fiber, prev);
  if (contexts.length > 0) return { reason: 'context', keys: contexts.map((c) => c.name), changed: contexts.map((c) => c.value) };
  const props = (fiber.memoizedProps ?? {}) as Record<string, unknown>;
  const prevProps = (prev.memoizedProps ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(props), ...Object.keys(prevProps)])).filter((k) => props[k] !== prevProps[k]);
  if (keys.length === 0) return { reason: 'parent', changed: [] };
  const changed = keys.map((k) => props[k]);
  // children 은 부모가 렌더될 때마다 새 element 라 내용 비교에서 빼고, 나머지 props 로 판정한다.
  const compared = keys.filter((k) => k !== 'children');
  if (compared.length === 0) return { reason: 'props', keys, changed };
  const callbacks = compared.filter((k) => typeof props[k] === 'function' && typeof prevProps[k] === 'function');
  const others = compared.filter((k) => !callbacks.includes(k));
  if (!others.every((k) => sameContent(props[k], prevProps[k]))) return { reason: 'props', keys, changed };
  // 실제로 바뀐 내용 없이 새 참조만 내려왔다. 함수가 섞이면 useCallback, 아니면 useMemo 로 줄인다.
  if (callbacks.length > 0) return { reason: 'new-callback', keys: compared, changed };
  return { reason: 'same-content', keys: compared, changed };
};

/**
 * 네트워크 원인: 자기 변경값에 최근 응답이 있으면 direct, 없으면 네트워크 때문에 렌더된 조상을 이어받는다.
 * 자기 state 가 바뀐 렌더는 조상을 이어받지 않는다(그 state 변경이 이 렌더의 원인이다).
 */
const causeOf = (result: ReasonResult, inherited: NetworkCause | undefined, now: number): NetworkCause | undefined => {
  const record = findRecentResponse(result.changed, now);
  if (record) return { record, via: 'direct' };
  if (result.reason === 'state') return undefined;
  return inherited ? { record: inherited.record, via: 'parent' } : undefined;
};

const isMemo = (fiber: Fiber) =>
  fiber.tag === SIMPLE_MEMO || fiber.tag === MEMO || (fiber as unknown as { return?: Fiber | null }).return?.tag === MEMO;

/** 이번 commit 에서 렌더된 컴포넌트를 기록하고 이벤트를 돌려준다. */
const record = (fiber: Fiber, now: number, inherited: NetworkCause | undefined): RenderEvent => {
  let entry = entries.get(fiber) ?? (fiber.alternate ? entries.get(fiber.alternate) : undefined);
  if (!entry) {
    entry = { name: nameOf(fiber.type), events: [], fiber, memoized: isMemo(fiber) };
    entries.set(fiber, entry);
    if (fiber.alternate) entries.set(fiber.alternate, entry);
  }
  entry.fiber = fiber;
  const ms = typeof fiber.selfBaseDuration === 'number' ? fiber.selfBaseDuration : undefined;
  // 감시를 켜기 전부터 있던 컴포넌트도 alternate 가 있으면 이전 렌더와 비교할 수 있다(mount 가 아니다).
  const result = reasonOf(fiber, false);
  const event: RenderEvent = { time: now, ms, reason: result.reason, keys: result.keys, cause: causeOf(result, inherited, now) };
  entry.events.push(event);
  if (entry.events.length > 200) entry.events.shift();
  active.add(entry);
  return event;
};

const onCommit = (root: { current: Fiber }) => {
  if (!enabled) return;
  const now = Date.now();
  let count = 0;
  // 위에서 아래로 내려가며, 가장 가까운 렌더된 조상의 네트워크 원인을 자식에게 넘긴다.
  // React DevTools 처럼 이번 commit 에서 다시 만든 서브트리만 내려간다. 재사용된 서브트리의 fiber 는
  // 지난 렌더의 PerformedWork 플래그가 남아 있어, 들어가면 렌더하지 않은 것을 렌더로 센다.
  const rootFiber = root.current;
  const stack: Array<[Fiber | null, NetworkCause | undefined]> = [];
  if (!rootFiber.alternate || rootFiber.child !== rootFiber.alternate.child) stack.push([rootFiber.child, undefined]);
  while (stack.length > 0) {
    let [fiber, inherited] = stack.pop()!;
    for (; fiber; fiber = fiber.sibling) {
      if (ignoredTypes.has(fiber.type)) continue;
      let childCause = inherited;
      if (COMPOSITE_TAGS.has(fiber.tag) && fiber.flags & PERFORMED_WORK) {
        const event = record(fiber, now, inherited);
        count++;
        childCause = event.cause;
      }
      if (fiber.child && (!fiber.alternate || fiber.child !== fiber.alternate.child)) stack.push([fiber.child, childCause]);
    }
  }
  if (count > 0) {
    commits.push({ time: now, count });
    if (commits.length > MAX_COMMITS) commits.shift();
    commitListeners.forEach((l) => l());
  }
};

/** 렌더가 있었던 commit 마다 부른다. 전체 표시가 박스를 다시 그릴 때 쓴다. */
export const subscribeCommits = (listener: () => void): (() => void) => {
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
};

export const summarize = (entry: RenderEntry): RenderSummary => {
  const since = Date.now() - WINDOW_MS;
  const recent = entry.events.filter((e) => e.time >= since);
  const reasons: Record<RenderReason, number> = { mount: 0, state: 0, context: 0, props: 0, 'same-content': 0, 'new-callback': 0, parent: 0 };
  const sameContentKeys = new Set<string>();
  const callbackKeys = new Set<string>();
  const contextKeys = new Set<string>();
  const causes = new Map<string, { record: RequestRecord; direct: number; parent: number }>();
  let ms = 0;
  let network = 0;
  for (const e of recent) {
    reasons[e.reason]++;
    ms += e.ms ?? 0;
    if (e.reason === 'same-content') e.keys?.forEach((k) => sameContentKeys.add(k));
    if (e.reason === 'new-callback') e.keys?.forEach((k) => callbackKeys.add(k));
    if (e.reason === 'context') e.keys?.forEach((k) => contextKeys.add(k));
    if (e.cause) {
      network++;
      const key = `${e.cause.record.method} ${e.cause.record.url.split('?')[0]}`;
      const c = causes.get(key) ?? { record: e.cause.record, direct: 0, parent: 0 };
      c.record = e.cause.record;
      c[e.cause.via]++;
      causes.set(key, c);
    }
  }
  return {
    recent: recent.length,
    last: entry.events[entry.events.length - 1]?.time ?? 0,
    ms,
    reasons,
    // 이미 React.memo 인데 부모 때문에 렌더됐다면(forceUpdate 등) memo 로는 줄일 수 없으니 세지 않는다.
    avoidable: AVOIDABLE_REASONS.reduce((sum, r) => sum + (r === 'parent' && entry.memoized ? 0 : reasons[r]), 0),
    sameContentKeys: Array.from(sameContentKeys),
    callbackKeys: Array.from(callbackKeys),
    contextKeys: Array.from(contextKeys),
    memoized: entry.memoized,
    network,
    causes: Array.from(causes.values()).sort((a, b) => b.direct + b.parent - (a.direct + a.parent)),
  };
};

/** 컴포넌트(fiber) 하나의 최근 10초 렌더 요약 */
export const getRenderInfo = (fiber: unknown): RenderSummary | null => {
  const f = fiber as Fiber;
  const entry = entries.get(f) ?? (f.alternate ? entries.get(f.alternate) : undefined);
  return entry ? summarize(entry) : null;
};

const setupHook = () => {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook };
  let hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    // React DevTools 확장이 없을 때 react-dom 이 등록할 수 있는 최소한의 훅을 만든다.
    const renderers = new Map<number, unknown>();
    let id = 0;
    hook = {
      renderers,
      supportsFiber: true,
      inject: (renderer) => {
        renderers.set(++id, renderer);
        return id;
      },
      onCommitFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      checkDCE: () => undefined,
    };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }
  const original = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = (id, root, ...rest) => {
    try {
      onCommit(root);
    } catch {
      // 감시 실패가 앱 렌더를 깨면 안 된다.
    }
    return original(id, root, ...rest);
  };
};

if (process.env.NODE_ENV !== 'production') setupHook();

/** 이 컴포넌트와 그 하위는 세지 않는다. */
export const ignoreComponent = (type: unknown): void => {
  ignoredTypes.add(type);
};

// 렌더 탭과 타임라인 탭이 동시에 켤 수 있어 사용 수를 센다.
let users = 0;

export const setRenderMonitoring = (on: boolean): void => {
  users = Math.max(0, users + (on ? 1 : -1));
  enabled = users > 0;
  if (!enabled) {
    active.clear();
    commits.length = 0;
  }
};

export const getCommits = (): readonly Commit[] => commits;

/** 최근 10초 렌더 횟수가 많은 순 */
export const getTopRenders = (limit = 20): Array<RenderEntry & RenderSummary> => {
  return Array.from(active)
    .map((e) => ({ ...e, ...summarize(e) }))
    .filter((e) => e.recent > 0)
    .sort((a, b) => b.recent - a.recent)
    .slice(0, limit);
};
