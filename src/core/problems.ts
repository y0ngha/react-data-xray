import { getTopRenders } from './render/monitor.js';
import { RENDER_STORM } from './render/types.js';

/**
 * RDX 버튼 배지와 보고서 summary 가 같이 쓰는 "문제" 기준. 두 곳이 다른 말을 하지 않게 여기 한 곳에 둔다(#70).
 * - 낭비 요청(duplicates·sameResponses)이 있는 엔드포인트: `isWastefulStat`
 * - 렌더 폭주 중인 컴포넌트: 최근 10초에 RENDER_STORM 번 이상 렌더된 인스턴스가 있는 컴포넌트
 */
export { isWastefulStat } from './requests/endpointStats.js';

// 배지가 훑는 렌더 항목 수. 폭주는 렌더가 많은 순 앞쪽에 있으므로 이만큼이면 충분하다.
const STORM_SCAN = 500;

/** 지금 렌더 폭주 중인 컴포넌트 이름과 그 이름 인스턴스의 최근 10초 렌더 수(가장 많은 인스턴스) */
export const findRenderStorms = (now = Date.now()): Map<string, number> =>
  getTopRenders(STORM_SCAN, now)
    .filter((e) => e.recent >= RENDER_STORM)
    .reduce((acc, e) => acc.set(e.name, Math.max(acc.get(e.name) ?? 0, e.recent)), new Map<string, number>());

/** 배지에 다는 문제 수: 낭비 요청이 있는 엔드포인트 수 + 렌더 폭주 중인 컴포넌트 수 */
export const countProblems = (wasteEndpoints: number, stormingComponents: number): number => wasteEndpoints + stormingComponents;
