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
 * - timing: 응답 객체는 못 찾았지만(가공해 넣었거나 빈 배열) 응답이 도착한 직후 자기 state 가 바뀌었다(시간으로 추정)
 * - parent: 같은 commit 에서 네트워크 응답 때문에 렌더된 조상을 따라 렌더됐다
 */
export interface NetworkCause {
  record: RequestRecord;
  via: 'direct' | 'timing' | 'parent';
}

/** 렌더를 시작한 컴포넌트: 자기 state·context 가 바뀌었거나 새로 붙은 가장 가까운 조상(부모를 따라 렌더된 자손이 이어받는다) */
export interface RenderOrigin {
  name: string;
  reason: RenderReason;
  /** 시작한 컴포넌트의 기록. 같은 이름의 다른 위치 컴포넌트와 구분하는 데만 쓴다(보고서·집계 결과에는 싣지 않는다). */
  from?: { name: string; location?: string; package?: string; owner?: { name: string; location?: string } };
}

/** state 때문에 렌더됐을 때, 값이 바뀐 훅 하나 */
export interface HookChange {
  /**
   * 이 컴포넌트가 이 훅을 부른 순서(1부터, useContext·useEffect 도 센다). 코드를 위에서부터 읽으며 세는 번호다.
   * dev 빌드의 훅 목록과 맞추지 못하면 내부 훅 칸의 순서다(type 이 없다).
   */
  index: number;
  /** useState·useReducer 등. dev 빌드의 훅 목록과 맞출 수 있을 때만 */
  type?: string;
  /** 바뀌기 전·후 값의 짧은 미리보기 */
  from: string;
  to: string;
}

export interface RenderEvent {
  time: number;
  reason: RenderReason;
  /** reason 이 state 이면 값이 바뀐 훅들 */
  hooks?: HookChange[];
  cause?: NetworkCause;
  /** 조상 때문에 렌더됐다면 그 렌더를 시작한 조상. 스스로 시작한 렌더면 없다. */
  origin?: RenderOrigin;
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
  /** 이 컴포넌트를 그리는 JSX 위치(dev 빌드가 기록할 때만) */
  location?: string;
  /** 라이브러리 코드가 만든 element 를 그리는 컴포넌트면 그 패키지 이름(그리는 위치가 앱 코드가 아니다) */
  package?: string;
  /** 라이브러리 컴포넌트를 그린 가장 가까운 앱 컴포넌트 */
  owner?: { name: string; location?: string };
  /** React Compiler 가 메모하는 컴포넌트인지. 그러면 React.memo 대신 구조를 바꾸라고 권한다. */
  compiled?: boolean;
  /** memo 가 부모의 렌더를 건너뛴 시각(최근 것만 남긴다) */
  skips?: number[];
}

/** memo 컴포넌트가 부모 렌더를 건너뛴 횟수와 다시 렌더된 횟수(마운트 제외) */
export interface MemoStats {
  skipped: number;
  rendered: number;
  /** 한 번도 건너뛰지 못했을 때, 렌더마다 새 참조(새 콜백·내용이 같은 새 객체)로 내려온 props */
  neverSkippedProps: string[];
}

/** 최근 구간에 값이 바뀐 상태 훅 하나의 요약 */
export interface StateHookSummary {
  /** 화면 표시: "useState #3" */
  label: string;
  count: number;
  /** 일정한 간격으로 바뀌었다면 그 간격(ms). 타이머(setInterval) 신호다. */
  intervalMs?: number;
  /** 가장 최근 변경 */
  last: { from: string; to: string };
}

/**
 * 이 컴포넌트가 스스로 시작한 렌더(state·context 변경)가 하위에 미친 영향.
 * 하위 대부분이 값이 그대로인데 따라 렌더됐다면, 바뀌는 값을 그것을 쓰는 곳 가까이로 내리라는 신호다.
 */
export interface OriginImpact {
  /** 이 컴포넌트를 따라 렌더된 하위 렌더 수 */
  renders: number;
  /** 그중 props·state·context 값이 그대로였던 렌더 수 */
  unchanged: number;
  /** 값이 그대로인데 렌더된 하위 컴포넌트 수(이름 기준) */
  unchangedComponents: number;
  /** 따라 렌더된 하위의 렌더 시간 합과 그중 값이 그대로인 렌더의 합(ms). 시간 기록이 없으면 없다. */
  childMs?: number;
  unchangedMs?: number;
  /** 값이 실제로 바뀐 props: "AnalysisPanel.reanalyzeCooldownMs" (위에서 아래 순서) */
  changedProps: string[];
}

export interface NetworkCauseCount {
  record: RequestRecord;
  direct: number;
  /** 응답 도착 직후의 자기 state 변경(시간으로 추정) */
  timing: number;
  parent: number;
  /** 그중 직전과 똑같은 응답(같은 응답 재요청)으로 일어난 렌더 */
  sameResponse: number;
}

export interface OriginCount extends RenderOrigin {
  count: number;
}

export interface RenderSummary {
  recent: number;
  last: number;
  /** 최근 10초 자기 자신의 렌더 시간 합(ms) */
  ms: number;
  /** 시간(ms)이 기록된 렌더 수. 0 이면 dev 빌드가 시간을 주지 않은 것이라 ms 는 의미가 없다. */
  timed?: number;
  /** 줄일 수 있는 렌더의 시간 합(ms) */
  avoidableMs?: number;
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
  /** 조상 때문에 렌더됐을 때 그 렌더를 시작한 조상(많은 순) */
  origins: OriginCount[];
  /** state 때문에 렌더됐다면 값이 바뀐 훅들(많은 순) */
  stateHooks: StateHookSummary[];
  compiled: boolean;
  /** React.memo 컴포넌트일 때만 */
  memo?: MemoStats;
}

export interface Commit {
  /** 화면 key 로 쓰는 순번(같은 밀리초에 여러 commit 이 있을 수 있다) */
  id: number;
  time: number;
  /** 이 commit 에서 렌더된 컴포넌트 수 */
  count: number;
  /** 이 commit 에서 렌더된 컴포넌트의 자기 렌더 시간 합(ms). 시간 기록이 없으면 없다. */
  ms?: number;
  /** 이 commit 을 시작한 컴포넌트(스스로 state·context 가 바뀌었거나 마운트된 가장 위 컴포넌트) */
  startedBy?: string;
}
