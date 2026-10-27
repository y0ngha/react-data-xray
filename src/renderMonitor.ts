// React DevTools 와 같은 전역 훅의 commit 이벤트로 컴포넌트별 렌더 횟수를 센다.
// react-dom 은 로드될 때 이 훅에 자신을 등록하므로, 이 모듈은 react-dom 보다 먼저 평가돼야 한다.

interface Fiber {
  tag: number;
  type: unknown;
  memoizedProps: unknown;
  memoizedState: unknown;
  /** dev 빌드가 기록하는, 자식을 뺀 이 컴포넌트 자신의 마지막 렌더 시간(ms) */
  selfBaseDuration?: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  flags: number;
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
 * 렌더된 이유. same-content 와 parent 는 줄일 수 있는 렌더다.
 * - same-content: 바뀐 props 가 참조만 새롭고 내용은 같다 → useMemo, 구조적 공유 후보
 * - parent: props 도 state 도 그대로인데 렌더됐다(부모 렌더 또는 context 변경) → React.memo 후보
 */
export type RenderReason = 'mount' | 'state' | 'props' | 'same-content' | 'parent';

export interface RenderEvent {
  time: number;
  reason: RenderReason;
  /** 자기 자신의 렌더 시간(ms). dev 빌드가 기록하지 않으면 없다. */
  ms?: number;
  /** props 때문이면 바뀐 props 이름 */
  keys?: string[];
}

export interface RenderEntry {
  name: string;
  /** 렌더 기록(최근 것만 남긴다) */
  events: RenderEvent[];
  fiber: Fiber;
}

export interface RenderSummary {
  recent: number;
  last: number;
  /** 최근 10초 자기 자신의 렌더 시간 합(ms) */
  ms: number;
  reasons: Record<RenderReason, number>;
  /** 줄일 수 있는 렌더(same-content + parent) */
  avoidable: number;
  /** same-content 로 렌더를 일으킨 props 이름 */
  sameContentKeys: string[];
}

const COMPOSITE_TAGS = new Set([0, 1, 11, 15]);
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

/** useState·useReducer 처럼 queue 가 있는 훅의 값이 바뀌었는지. effect·memo 훅은 매 렌더 새 객체라 보지 않는다. */
const stateChanged = (fiber: Fiber, prev: Fiber): boolean => {
  if (fiber.tag === 1) return fiber.memoizedState !== prev.memoizedState;
  let a = fiber.memoizedState as Hook | null;
  let b = prev.memoizedState as Hook | null;
  for (; a && b && typeof a === 'object' && 'next' in a; a = a.next, b = b.next) {
    if (a.queue && a.memoizedState !== b.memoizedState) return true;
  }
  return false;
};

const MAX_COMPARE_CHARS = 20_000;

/** 참조는 다르지만 내용이 같은지. 크거나 직렬화할 수 없는 값은 다르다고 본다. */
const sameContent = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    const sa = JSON.stringify(a);
    return sa.length <= MAX_COMPARE_CHARS && sa === JSON.stringify(b);
  } catch {
    return false;
  }
};

const reasonOf = (fiber: Fiber, isNew: boolean): Omit<RenderEvent, 'time'> => {
  const prev = fiber.alternate;
  if (!prev || isNew) return { reason: 'mount' };
  if (stateChanged(fiber, prev)) return { reason: 'state' };
  const props = (fiber.memoizedProps ?? {}) as Record<string, unknown>;
  const prevProps = (prev.memoizedProps ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(props), ...Object.keys(prevProps)])).filter((k) => props[k] !== prevProps[k]);
  if (keys.length === 0) return { reason: 'parent' };
  // children 은 부모가 렌더될 때마다 새 element 라 내용 비교 대상에서 뺀다.
  const compared = keys.filter((k) => k !== 'children');
  if (compared.length > 0 && compared.length === keys.length && compared.every((k) => sameContent(props[k], prevProps[k]))) {
    return { reason: 'same-content', keys: compared };
  }
  return { reason: 'props', keys };
};

const record = (fiber: Fiber, now: number): boolean => {
  let entry = entries.get(fiber) ?? (fiber.alternate ? entries.get(fiber.alternate) : undefined);
  // 부모가 bailout 하면 하위 fiber 는 지난 commit 의 객체(와 플래그)가 그대로 남는다. 같은 객체면 렌더하지 않은 것이다.
  if (entry && entry.fiber === fiber) return false;
  // 처음 보는 fiber 는 지난 렌더의 플래그가 남아 있을 수 있다. 이전 트리와 props·state 가 같으면 이번에 렌더하지 않은 것이다.
  if (!entry && fiber.alternate && fiber.alternate.memoizedProps === fiber.memoizedProps && fiber.alternate.memoizedState === fiber.memoizedState) {
    entry = { name: nameOf(fiber.type), events: [], fiber };
    entries.set(fiber, entry);
    entries.set(fiber.alternate, entry);
    return false;
  }
  const isNew = !entry;
  if (!entry) {
    entry = { name: nameOf(fiber.type), events: [], fiber };
    entries.set(fiber, entry);
    if (fiber.alternate) entries.set(fiber.alternate, entry);
  }
  entry.fiber = fiber;
  const ms = typeof fiber.selfBaseDuration === 'number' ? fiber.selfBaseDuration : undefined;
  // 감시를 켜기 전부터 있던 컴포넌트는 처음 볼 때 이전 렌더와 비교할 수 있다(mount 가 아니다).
  entry.events.push({ time: now, ms, ...reasonOf(fiber, isNew && !fiber.alternate) });
  if (entry.events.length > 200) entry.events.shift();
  active.add(entry);
  return true;
};

const onCommit = (root: { current: Fiber }) => {
  if (!enabled) return;
  const now = Date.now();
  let count = 0;
  const stack: Array<Fiber | null> = [root.current.child];
  while (stack.length > 0) {
    let fiber = stack.pop() ?? null;
    for (; fiber; fiber = fiber.sibling) {
      if (ignoredTypes.has(fiber.type)) continue;
      if (COMPOSITE_TAGS.has(fiber.tag) && fiber.flags & PERFORMED_WORK && record(fiber, now)) count++;
      if (fiber.child) stack.push(fiber.child);
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
  const reasons: Record<RenderReason, number> = { mount: 0, state: 0, props: 0, 'same-content': 0, parent: 0 };
  const sameContentKeys = new Set<string>();
  let ms = 0;
  for (const e of recent) {
    reasons[e.reason]++;
    ms += e.ms ?? 0;
    if (e.reason === 'same-content') e.keys?.forEach((k) => sameContentKeys.add(k));
  }
  return {
    recent: recent.length,
    last: entry.events[entry.events.length - 1]?.time ?? 0,
    ms,
    reasons,
    avoidable: reasons['same-content'] + reasons.parent,
    sameContentKeys: Array.from(sameContentKeys),
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
