import { HOST_COMPONENT, HOST_ROOT, MEMO_COMPONENT, SIMPLE_MEMO_COMPONENT, type Fiber } from './types.js';

const FIBER_KEY_PREFIX = '__reactFiber$';
const CONTAINER_KEY_PREFIX = '__reactContainer$';

const findKey = (el: Element, prefix: string): string | undefined => Object.keys(el).find((k) => k.startsWith(prefix));
const readKey = <T>(el: Element, key: string): T => (el as unknown as Record<string, T>)[key];

const hostRootOf = (fiber: Fiber): Fiber => (fiber.return ? hostRootOf(fiber.return) : fiber);

/**
 * DOM 에 붙은 fiber 는 current 일 수도, 지난 commit 의 alternate 일 수도 있다.
 * HostRoot 까지 올라가 root.current 와 같은 쪽 트리인지 보고, 아니면 alternate 를 쓴다.
 */
export const toCurrent = (fiber: Fiber): Fiber => {
  const root = hostRootOf(fiber);
  if (root.tag !== HOST_ROOT) return fiber;
  return (root.stateNode as { current?: Fiber } | null)?.current === root ? fiber : (fiber.alternate ?? fiber);
};

/** 요소(또는 가장 가까운 조상 요소)의 현재 fiber */
export const getFiber = (el: Element): Fiber | null => {
  const key = findKey(el, FIBER_KEY_PREFIX);
  if (key) return toCurrent(readKey<Fiber>(el, key));
  return el.parentElement ? getFiber(el.parentElement) : null;
};

export const getComponentName = (fiber: Pick<Fiber, 'type'>): string => {
  const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return type?.displayName || type?.name || type?.render?.name || type?.type?.name || 'Anonymous';
};

/** React.memo 로 감싼 컴포넌트인지(memo 의 안쪽 컴포넌트 포함) */
export const isMemoized = (fiber: Fiber): boolean =>
  fiber.tag === SIMPLE_MEMO_COMPONENT || fiber.tag === MEMO_COMPONENT || fiber.return?.tag === MEMO_COMPONENT;

// React 루트 컨테이너는 거의 바뀌지 않으므로 찾은 것을 기억해 두고, 없을 때만 페이지를 훑는다.
let rootContainers: Element[] = [];

/**
 * commit 이 일어난 루트의 컨테이너를 기억한다. 앱이 나중에 모달·위젯용 createRoot 를 만들어도 찾을 수 있다.
 * (처음 한 번 문서를 훑은 뒤로는 목록이 빌 때까지 다시 훑지 않는다.)
 */
export const rememberRootContainer = (root: { containerInfo?: unknown }): void => {
  const el = root.containerInfo;
  if (el instanceof Element && !rootContainers.includes(el)) rootContainers = [...rootContainers, el];
};

/** 컨테이너에 붙은 HostRoot fiber. 루트를 unmount 하면 키는 남고 값이 null 이 된다. */
const hostRootOfContainer = (el: Element): Fiber | null => {
  const key = findKey(el, CONTAINER_KEY_PREFIX);
  return key ? readKey<Fiber | null>(el, key) : null;
};

/** 페이지의 모든(살아 있는) React 루트의 현재 HostRoot fiber */
export const findRootFibers = (): Fiber[] => {
  rootContainers = rootContainers.filter((el) => el.isConnected && hostRootOfContainer(el));
  if (rootContainers.length === 0) rootContainers = Array.from(document.querySelectorAll('*')).filter((el) => hostRootOfContainer(el));
  // 컨테이너에 붙은 HostRoot fiber 는 처음 만든 것이라 commit 마다 current/alternate 가 바뀐다. root.current 로 따라간다.
  return rootContainers
    .map(hostRootOfContainer)
    .filter((root): root is Fiber => root !== null)
    .map((root) => (root.stateNode as { current?: Fiber } | null)?.current ?? root);
};

/** 형제를 포함해 깊이 우선으로 모든 fiber 를 방문한다. visit 이 false 를 돌려주면 그 자식은 내려가지 않는다. */
export const walkFibers = (fiber: Fiber | null, visit: (fiber: Fiber) => boolean | void): void => {
  for (let f = fiber; f; f = f.sibling) {
    if (visit(f) !== false) walkFibers(f.child, visit);
  }
};

/** 컴포넌트가 그린 가장 바깥 DOM 요소들 */
export const hostNodesOf = (fiber: Fiber): Element[] => {
  const nodes: Element[] = [];
  walkFibers(fiber.child, (f) => {
    if (f.tag !== HOST_COMPONENT || !(f.stateNode instanceof Element)) return true;
    nodes.push(f.stateNode);
    return false;
  });
  return nodes;
};

/** 요소들을 모두 감싸는 사각형. 화면에 보이는 요소가 없으면 null */
export const unionRect = (els: readonly Element[]): DOMRect | null => {
  const rects = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
};

/** 컴포넌트가 화면에서 차지하는 영역. rdx 자신의 UI 는 뺀다. */
export const componentRect = (fiber: Fiber, isOwnUi: (el: Element) => boolean): DOMRect | null =>
  unionRect(hostNodesOf(fiber).filter((n) => !isOwnUi(n)));
