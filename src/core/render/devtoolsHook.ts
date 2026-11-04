import type { Fiber } from '../fiber/types.js';

interface DevtoolsHook {
  renderers: Map<number, unknown>;
  supportsFiber: boolean;
  inject: (renderer: unknown) => number;
  onCommitFiberRoot: (id: number, root: { current: Fiber }, ...rest: unknown[]) => void;
  onCommitFiberUnmount: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  checkDCE?: () => void;
}

/** React DevTools 확장이 없을 때 react-dom 이 등록할 수 있는 최소한의 훅 */
const createHook = (): DevtoolsHook => {
  const renderers = new Map<number, unknown>();
  return {
    renderers,
    supportsFiber: true,
    inject: (renderer) => {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  };
};

// 훅이 받은 commit 수. 렌더 감시가 꺼져 있어도(monitor 의 onCommit 이 일찍 끝나도) 센다.
// <RdxDevtools> 가 마운트된 뒤에도 0 이면 react-dom 이 rdx 보다 먼저 로드돼 다른 훅(또는 없음)에 붙은 것이다(#75).
let commitsSeen = 0;
let listening: DevtoolsHook | null = null;

/** commit 훅 상태: 듣고 있는지, 지금까지 받은 commit 수, 훅에 등록한 렌더러(react-dom)의 버전 */
export const commitHookStatus = (): { listening: boolean; commitsSeen: number; rendererVersions: string[] } => ({
  listening: listening !== null,
  commitsSeen,
  rendererVersions: listening
    ? Array.from(listening.renderers.values(), (r) => (r as { version?: unknown } | null)?.version).filter(
        (v): v is string => typeof v === 'string',
      )
    : [],
});

/**
 * React DevTools 와 같은 전역 훅의 commit 이벤트를 받는다.
 * react-dom 은 로드될 때 이 훅에 자신을 등록하므로, react-dom 보다 먼저 불러야 한다.
 */
export const listenToCommits = (onCommit: (root: { current: Fiber }) => void, onUnmount?: (fiber: Fiber) => void): void => {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook };
  // React DevTools 와 react-dom 이 약속한 전역 이름이라 바꿀 수 없다(.oxlintrc 에서 허용).
  const hook = (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= createHook());
  listening = hook;
  const original = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = (id, root, ...rest) => {
    commitsSeen++;
    try {
      onCommit(root);
    } catch {
      // 감시 실패가 앱 렌더를 깨면 안 된다.
    }
    return original(id, root, ...rest);
  };
  const originalUnmount = hook.onCommitFiberUnmount.bind(hook);
  hook.onCommitFiberUnmount = (id, fiber, ...rest) => {
    try {
      onUnmount?.(fiber as Fiber);
    } catch {
      // 감시 실패가 앱 렌더를 깨면 안 된다.
    }
    return originalUnmount(id, fiber, ...rest);
  };
};
