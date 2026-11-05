import { getLayoutShifts, layoutShiftSupported, type LayoutShift } from '../render/layoutShifts.js';
import { endpointOf } from '../requests/requestKey.js';

// 큰 이동부터 이만큼만 싣는다.
export const MAX_LAYOUT_SHIFT_ROWS = 20;
/** 한 컴포넌트의 이동 점수 합이 이 이상이면 summary 에 올린다. web-vitals 가 CLS 를 "좋음"으로 보는 상한이다. */
export const LARGE_LAYOUT_SHIFT = 0.1;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface LayoutShiftRow {
  /** 이 이동의 layout shift 점수 */
  value: number;
  secondsAgo: number;
  /** 밀린 노드를 그린 앱 컴포넌트와 그 JSX 위치. 노드가 React 밖이거나 이미 지워졌으면 없다 */
  component?: string;
  renderedAt?: string;
  /** 이동 직전 commit 에서 이 컴포넌트(또는 조상)를 렌더한 네트워크 응답. 렌더 감시가 꺼져 있었거나 네트워크와 무관하면 없다 */
  cause?: { endpoint: string; component: string; renderedAt?: string };
}

const rowOf = (s: LayoutShift, now: number): LayoutShiftRow => ({
  value: round3(s.value),
  secondsAgo: Math.max(0, Math.round((now - s.time) / 1000)),
  ...(s.component && { component: s.component.name, ...(s.component.location && { renderedAt: s.component.location }) }),
  ...(s.cause && {
    cause: {
      endpoint: endpointOf(s.cause.record),
      component: s.cause.component,
      ...(s.cause.location && { renderedAt: s.cause.location }),
    },
  }),
});

/**
 * 마지막 reset 뒤(안 했으면 페이지 로드 뒤)의 레이아웃 이동, 점수가 큰 순. 브라우저가 layout-shift 를 주지 않으면(Safari, Firefox) undefined.
 * 지금까지 분석된 이동만 싣는다(사용자 조회는 buildReport 가 큐를 먼저 비운다).
 */
export const buildLayoutShiftSection = (now: number): LayoutShiftRow[] | undefined => {
  if (!layoutShiftSupported()) return undefined;
  return getLayoutShifts()
    .slice()
    .sort((a, b) => b.value - a.value || b.time - a.time)
    .slice(0, MAX_LAYOUT_SHIFT_ROWS)
    .map((s) => rowOf(s, now));
};

export const LAYOUT_SHIFT_HOW_TO_READ: readonly string[] = [
  'layoutShifts lists layout shifts since the last reset (or page load), largest first, up to 20; shifts within 500ms of user input are left out, as in CLS. It is absent when the browser does not report layout shifts (Safari, Firefox): measure in Chrome or Edge. value is the shift score; component and renderedAt are the app component that drew the node that moved.',
  'layoutShifts[].cause is the network response that rendered that component (or its ancestor) in the last commit before the shift: endpoint, and the component that rendered with that response. It is absent when render monitoring was off or the commit had no network cause. Fix by reserving space before the data arrives (a skeleton with the final size, min-height, or width/height on images), usually in cause.component.',
];
