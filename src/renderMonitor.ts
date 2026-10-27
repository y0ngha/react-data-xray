// React DevTools 와 같은 전역 훅의 commit 이벤트로 컴포넌트별 렌더 횟수를 센다.
// react-dom 은 로드될 때 이 훅에 자신을 등록하므로, 이 모듈은 react-dom 보다 먼저 평가돼야 한다.

interface Fiber {
  tag: number;
  type: unknown;
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

export interface RenderEntry {
  name: string;
  /** 렌더된 시각(최근 것만 남긴다) */
  times: number[];
  fiber: Fiber;
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
const active = new Set<RenderEntry>();
let enabled = false;

const nameOf = (type: unknown): string => {
  const t = type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return t?.displayName || t?.name || t?.render?.name || t?.type?.name || 'Anonymous';
};

const record = (fiber: Fiber, now: number): boolean => {
  let entry = entries.get(fiber) ?? (fiber.alternate ? entries.get(fiber.alternate) : undefined);
  // 부모가 bailout 하면 하위 fiber 는 지난 commit 의 객체(와 플래그)가 그대로 남는다. 같은 객체면 렌더하지 않은 것이다.
  if (entry && entry.fiber === fiber) return false;
  if (!entry) {
    entry = { name: nameOf(fiber.type), times: [], fiber };
    entries.set(fiber, entry);
    if (fiber.alternate) entries.set(fiber.alternate, entry);
  }
  entry.fiber = fiber;
  entry.times.push(now);
  if (entry.times.length > 200) entry.times.shift();
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
  }
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
export const getTopRenders = (limit = 20): Array<RenderEntry & { recent: number }> => {
  const since = Date.now() - WINDOW_MS;
  return Array.from(active)
    .map((e) => ({ ...e, recent: e.times.filter((t) => t >= since).length }))
    .filter((e) => e.recent > 0)
    .sort((a, b) => b.recent - a.recent)
    .slice(0, limit);
};
