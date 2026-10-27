// React 내부 구조(fiber)는 공개 API 가 아니다. React 18, 19 에서 같은 필드를 쓴다.

interface ContextDependency {
  context: { displayName?: string } | null;
  memoizedValue: unknown;
  next: ContextDependency | null;
}

export interface Fiber {
  tag: number;
  type: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  flags: number;
  memoizedProps: unknown;
  memoizedState: unknown;
  stateNode: unknown;
  /** dev 빌드가 기록하는, 자식을 뺀 이 컴포넌트 자신의 마지막 렌더 시간(ms) */
  selfBaseDuration?: number;
  /** 이 컴포넌트가 읽은 context 목록 */
  dependencies?: { firstContext: ContextDependency | null } | null;
  /** dev 빌드(React 18)가 기록하는, 이 컴포넌트를 그리는 JSX 의 위치 */
  _debugSource?: { fileName?: string; lineNumber?: number } | null;
}

/** 함수 컴포넌트의 훅은 memoizedState 에서 시작하는 연결 리스트다. */
export interface Hook {
  memoizedState: unknown;
  queue: unknown;
  next: Hook | null;
}

export const FUNCTION_COMPONENT = 0;
export const CLASS_COMPONENT = 1;
export const HOST_ROOT = 3;
export const HOST_COMPONENT = 5;
export const FORWARD_REF = 11;
export const MEMO_COMPONENT = 14;
export const SIMPLE_MEMO_COMPONENT = 15;
// 이번 commit 에서 실제로 렌더 함수를 실행했다는 플래그(React 18, 19)
export const PERFORMED_WORK = 1;

// memo(Comp, compare)(tag 14)는 안쪽 Comp 가 따로 fiber 를 가지므로 넣지 않는다.
const COMPOSITE_TAGS = new Set([FUNCTION_COMPONENT, CLASS_COMPONENT, FORWARD_REF, SIMPLE_MEMO_COMPONENT]);

/** 사용자가 만든 컴포넌트(함수·클래스·forwardRef·memo)인지 */
export const isComposite = (fiber: Fiber): boolean => COMPOSITE_TAGS.has(fiber.tag);
