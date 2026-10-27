import type { RequestRecord } from '../requests/types.js';

/**
 * 렌더된 이유. same-content, new-callback, parent 는 줄일 수 있는 렌더다.
 * - state: useState·useReducer·useSyncExternalStore·useDeferredValue 값이나 클래스 state 가 바뀜
 * - context: 읽고 있는 context 값이 바뀜 → context 나누기, value useMemo, selector
 * - props: props 일부가 내용까지 바뀜
 * - same-content: 바뀐 props 가 참조만 새롭고 내용은 같다 → useMemo, 구조적 공유 후보
 * - new-callback: 바뀐 props 가 렌더마다 새로 만든 함수다(나머지는 내용이 같다) → useCallback 후보
 * - parent: props·state·context 가 그대로인데 렌더됐다(부모가 렌더됨) → React.memo 후보
 */
export type RenderReason = 'mount' | 'state' | 'context' | 'props' | 'same-content' | 'new-callback' | 'parent';

/** 최근 10초에 컴포넌트 하나가 이만큼 넘게 렌더되면 렌더 폭주로 본다. */
export const RENDER_STORM = 10;

export const RENDER_REASONS: readonly RenderReason[] = ['mount', 'state', 'context', 'props', 'same-content', 'new-callback', 'parent'];

/**
 * 이 렌더가 네트워크 응답 때문인지. 렌더는 네트워크와 무관할 수 있으므로 근거가 있을 때만 붙인다.
 * - direct: 새로 바뀐 state·props·context 안에 최근(3초 안) 도착한 응답의 객체가 있다
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
  /** 가장 최근에 렌더된 fiber */
  fiber: unknown;
  /** 이미 React.memo 로 감싼 컴포넌트인지(그러면 React.memo 를 권하지 않는다) */
  memoized: boolean;
}

export interface NetworkCauseCount {
  record: RequestRecord;
  direct: number;
  parent: number;
}

export interface RenderSummary {
  recent: number;
  last: number;
  /** 최근 10초 자기 자신의 렌더 시간 합(ms) */
  ms: number;
  reasons: Record<RenderReason, number>;
  /** 줄일 수 있는 렌더(same-content + new-callback + memo 가 아닌 컴포넌트의 parent) */
  avoidable: number;
  sameContentKeys: string[];
  callbackKeys: string[];
  contextKeys: string[];
  memoized: boolean;
  /** 네트워크 응답 때문에 생긴 렌더 수(나머지는 네트워크와 무관) */
  network: number;
  /** 원인 요청(엔드포인트별 최신 요청)과 직접·부모 경유 횟수 */
  causes: NetworkCauseCount[];
}

export interface Commit {
  /** 화면 key 로 쓰는 순번(같은 밀리초에 여러 commit 이 있을 수 있다) */
  id: number;
  time: number;
  /** 이 commit 에서 렌더된 컴포넌트 수 */
  count: number;
}
