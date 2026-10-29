import { isLibraryFrame } from '../capture/libraryFrame.js';
import { resolveStack } from '../capture/sourceMap.js';
import { HOST_COMPONENT, HOST_ROOT, MEMO_COMPONENT, SIMPLE_MEMO_COMPONENT, type Fiber } from './types.js';

const FIBER_KEY_PREFIX = '__reactFiber$';
const CONTAINER_KEY_PREFIX = '__reactContainer$';

const findKey = (el: Node, prefix: string): string | undefined => Object.keys(el).find((k) => k.startsWith(prefix));
const readKey = <T>(el: Node, key: string): T => (el as unknown as Record<string, T>)[key];

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

/** 아직 화면에 붙어 있는지. 언마운트된 fiber 는 return 이 끊겨 HostRoot 까지 올라가지 못한다. */
export const isMounted = (fiber: Fiber): boolean => hostRootOf(fiber).tag === HOST_ROOT;

/** fiber 가 scope 컴포넌트이거나 그 자손인지. 렌더마다 current·alternate 가 번갈아 쓰여 둘 다 비교한다. */
export const isWithin = (fiber: Fiber, scope: Fiber): boolean => {
  for (let f: Fiber | null = fiber; f; f = f.return) {
    if (f === scope || f === scope.alternate) return true;
  }
  return false;
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

/** 파일 경로·모듈 주소를 src/... 부터로 줄인다(번들러가 붙인 쿼리는 뗀다). */
const shortPath = (path: string): string => path.split('?')[0].replace(/^.*?\/(src|app|pages|components)\//, '$1/');

// React·라이브러리 프레임(사전 번들 포함)과 React 19 가 스택 맨 위에 붙이는 표식 프레임
const LIBRARY_FRAME = /\/node_modules\/|\/\.vite\/deps\/|react-stack-top-frame/;
// V8 "at fn (url:1:2)"·"at url:1:2", Firefox·Safari "fn@url:1:2" 의 주소와 줄
const FRAME_LOCATION = /(?:\(|@|at )((?:[a-z]+:\/\/)?[^\s()@]+):(\d+):\d+\)?$/;

/** React 19 의 _debugStack 에서, 이 element 를 만든(JSX 를 쓴) 앱 코드 프레임 */
const jsxFrameOf = (fiber: Fiber): string | undefined =>
  fiber._debugStack?.stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => FRAME_LOCATION.test(line) && !LIBRARY_FRAME.test(line));

export const locationOfFrame = (frame: string): string | undefined => {
  const match = FRAME_LOCATION.exec(frame);
  return match ? `${shortPath(match[1])}:${match[2]}` : undefined;
};

/**
 * 이 컴포넌트를 그리는 JSX 위치(src/... 부터, 줄 번호 포함). React 18 은 _debugSource, React 19 는 _debugStack 에서 읽는다.
 * React 19 의 줄은 dev 서버가 변환한 코드 기준이라, 원본 줄은 resolveJsxLocation 으로 따로 구한다. dev 빌드가 아니면 undefined
 */
export const jsxLocationOf = (fiber: Fiber): string | undefined => {
  const source = fiber._debugSource;
  if (source?.fileName) return source.lineNumber ? `${shortPath(source.fileName)}:${source.lineNumber}` : shortPath(source.fileName);
  const frame = jsxFrameOf(fiber);
  return frame && locationOfFrame(frame);
};

// React 19 의 _debugStack 맨 위에 있는 React 런타임 프레임(jsx 를 부른 쪽이 아니다)
const RUNTIME_FRAME = /react-stack-top-frame|jsx-dev-runtime|jsx-runtime|react_jsx|\/react\/|\/react-dom\//;

/** 번들 경로에서 패키지 이름: node_modules/@scope/pkg/ 의 마지막 것, Vite 사전 번들은 파일 이름(@mui_material → @mui/material) */
const packageOfPath = (path: string): string => {
  const dep = /\.vite\/deps\/([^/?:]+?)\.js/.exec(path)?.[1];
  if (dep) return dep.startsWith('chunk-') ? '(bundle)' : dep.replace(/^(@[^_]+)_/, '$1/');
  return /^.*node_modules\/(@[^/]+\/[^/?:]+|[^/?:]+)\//.exec(path)?.[1] ?? '(bundle)';
};

/**
 * 이 컴포넌트의 element 를 라이브러리 코드가 만들었다면 그 패키지 이름(앱 코드가 만들었거나 알 수 없으면 undefined).
 * React 18 은 _debugSource, React 19 는 _debugStack 의 맨 위 프레임을 본다.
 */
export const libraryPackageOf = (fiber: Fiber): string | undefined => {
  const file = fiber._debugSource?.fileName;
  if (file) return isLibraryFrame(file) ? packageOfPath(file) : undefined;
  const top = fiber._debugStack?.stack
    ?.split('\n')
    .slice(1)
    .find((line) => FRAME_LOCATION.test(line.trim()) && !RUNTIME_FRAME.test(line));
  return top && isLibraryFrame(top) ? packageOfPath(top) : undefined;
};

/** React 19 의 JSX 위치를 소스맵으로 원본 줄로 바꾼다. 바꿀 것이 없으면(React 18, 소스맵 없음) undefined */
export const resolveJsxLocation = async (fiber: Fiber): Promise<string | undefined> => {
  const frame = fiber._debugSource ? undefined : jsxFrameOf(fiber);
  if (!frame) return undefined;
  const resolved = await resolveStack(frame);
  return resolved === frame ? undefined : locationOfFrame(resolved);
};

/** React.memo 로 감싼 컴포넌트인지(memo 의 안쪽 컴포넌트 포함) */
export const isMemoized = (fiber: Fiber): boolean =>
  fiber.tag === SIMPLE_MEMO_COMPONENT || fiber.tag === MEMO_COMPONENT || fiber.return?.tag === MEMO_COMPONENT;

// React 루트 컨테이너는 거의 바뀌지 않으므로 찾은 것을 기억해 두고, 없을 때만 페이지를 훑는다.
/**
 * React 루트의 컨테이너. 보통 요소지만, Next.js App Router 는 hydrateRoot(document) 로 문서 자체를 쓴다.
 * 문서를 빼면 그 앱의 화면 전체를 못 본다(박스·데이터를 쓰는 컴포넌트·React Query 점검이 비었다).
 */
type RootContainer = Element | Document;

const isRootContainer = (value: unknown): value is RootContainer => value instanceof Element || value instanceof Document;

let rootContainers: RootContainer[] = [];

// 프레임워크가 dev 에서 띄우는 자체 개발 도구의 shadow DOM 호스트(Next.js dev overlay). 앱이 아니라 측정에서 뺀다.
const FRAMEWORK_DEVTOOLS_HOSTS = new Set(['NEXTJS-PORTAL']);

/**
 * 프레임워크 개발 도구(Next.js dev overlay 등)가 따로 만든 React 루트인지. 그 렌더는 축약된 이름(e0, tn…)으로 섞여 들어온다.
 * Next.js 16 은 <nextjs-portal> 요소 자체를, 이전 버전은 그 shadow DOM 안의 요소를 컨테이너로 쓴다.
 */
export const isFrameworkDevtoolsRoot = (container: unknown): boolean => {
  if (!(container instanceof Node)) return false;
  if (container instanceof Element && FRAMEWORK_DEVTOOLS_HOSTS.has(container.tagName)) return true;
  const host = (container.getRootNode() as Partial<ShadowRoot>).host;
  return !!host && FRAMEWORK_DEVTOOLS_HOSTS.has(host.tagName);
};

/**
 * commit 이 일어난 루트의 컨테이너를 기억한다. 앱이 나중에 모달·위젯용 createRoot 를 만들어도 찾을 수 있다.
 * (처음 한 번 문서를 훑은 뒤로는 목록이 빌 때까지 다시 훑지 않는다.)
 */
export const rememberRootContainer = (root: { containerInfo?: unknown }): void => {
  const el = root.containerInfo;
  if (isRootContainer(el) && !isFrameworkDevtoolsRoot(el) && !rootContainers.includes(el)) rootContainers = [...rootContainers, el];
};

/** 컨테이너에 붙은 HostRoot fiber. 루트를 unmount 하면 키는 남고 값이 null 이 된다. */
const hostRootOfContainer = (el: RootContainer): Fiber | null => {
  const key = findKey(el, CONTAINER_KEY_PREFIX);
  return key ? readKey<Fiber | null>(el, key) : null;
};

/** 페이지의 모든(살아 있는) React 루트의 현재 HostRoot fiber */
export const findRootFibers = (): Fiber[] => {
  rootContainers = rootContainers.filter((el) => el.isConnected && hostRootOfContainer(el));
  if (rootContainers.length === 0) {
    rootContainers = [document, ...Array.from(document.querySelectorAll('*'))].filter(
      (el) => hostRootOfContainer(el) && !isFrameworkDevtoolsRoot(el),
    );
  }
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
