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

/**
 * React DevTools 와 같은 전역 훅의 commit 이벤트를 받는다.
 * react-dom 은 로드될 때 이 훅에 자신을 등록하므로, react-dom 보다 먼저 불러야 한다.
 */
export const listenToCommits = (onCommit: (root: { current: Fiber }) => void): void => {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook };
  // React DevTools 와 react-dom 이 약속한 전역 이름이라 바꿀 수 없다.
  // oxlint-disable-next-line no-underscore-dangle
  const hook = (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= createHook());
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
