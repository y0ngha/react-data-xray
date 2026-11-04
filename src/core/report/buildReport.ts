import { effectiveConfig, type EffectiveConfig } from '../config.js';
import { knownQueryContextOf, queryContextOf } from '../capture/queryContext.js';
import { queueIndex } from '../inspect/derivedMatch.js';
import { flushQueue } from '../scheduler/idleQueue.js';
import { buildDiagnostics, type RdxDiagnostics } from '../diagnostics/diagnostics.js';
import { classifyRecords } from '../requests/classify.js';
import { getRecords } from '../requests/store.js';
import { readIgnoredEndpoints } from '../../shared/ignoredEndpoints.js';
import {
  buildReactQuerySection,
  REACT_QUERY_HOW_TO_READ,
  REACT_QUERY_HOW_TO_READ_EXTRA,
  type ReactQuerySection,
} from './reactQuerySection.js';
import { buildRenderSection, RENDER_HOW_TO_READ, RENDER_HOW_TO_READ_EXTRA, type RenderSection } from './renderSection.js';
import { buildRequestSection, REQUEST_HOW_TO_READ, REQUEST_HOW_TO_READ_EXTRA, type RequestSection } from './requestSection.js';
import { getResetAt } from './resetAt.js';

/** AI·사람이 읽는 rdx 결과 요약. 응답 본문과 헤더는 넣지 않는다(인증 정보가 섞일 수 있다). */
export interface RdxReport {
  generatedAt: string;
  /** 이 탭에서 마지막으로 reset 한 시각(ms). reset 한 적이 없으면 null */
  resetAt: number | null;
  page: string;
  howToRead: string[];
  /** configure() 로 정한(또는 기본) 판정 기준. compare 가 기준이 다른 두 보고서를 경고한다 */
  config: EffectiveConfig;
  requests: RequestSection;
  reactQuery: ReactQuerySection;
  renders: RenderSection;
  /** rdx 가 제대로 붙었는지(window.__RDX__.doctor() 와 같다). 결과를 읽기 전에 problems 를 먼저 본다 */
  diagnostics: RdxDiagnostics;
}

// 섹션별 줄을 읽는 순서로 잇는다.
const HOW_TO_READ = [
  REQUEST_HOW_TO_READ.waste,
  REQUEST_HOW_TO_READ.review,
  REQUEST_HOW_TO_READ.ignored,
  REQUEST_HOW_TO_READ.restored,
  REQUEST_HOW_TO_READ.callers,
  RENDER_HOW_TO_READ.window,
  REQUEST_HOW_TO_READ.dropped,
  REACT_QUERY_HOW_TO_READ,
  RENDER_HOW_TO_READ.viaParent,
  RENDER_HOW_TO_READ.byTiming,
  RENDER_HOW_TO_READ.sameResponse,
  RENDER_HOW_TO_READ.causedBy,
  RENDER_HOW_TO_READ.stateChanges,
  RENDER_HOW_TO_READ.startedRenders,
  ...REQUEST_HOW_TO_READ_EXTRA,
  ...RENDER_HOW_TO_READ_EXTRA,
  ...REACT_QUERY_HOW_TO_READ_EXTRA,
  'Check diagnostics.problems first: if rdx was loaded after react-dom (renderHook.commitsSeen is 0) or requests went out before it loaded (capture.requestsBeforeInstall), the rest of the report is incomplete. Each problem says how to fix it.',
  'config is the detection settings in effect (configure() in code, or the defaults): ignore (endpoints not counted as waste: code = configure() names and /RegExp/ strings, panel = chosen in the panel), keyHeaders (request headers that are part of the request identity), dedupeWindowMs, burst (windowMs, count), maxRecords, reportPath. compare warns when the detection criteria (dedupeWindowMs, burst, keyHeaders, ignore, and maxRecords when requests were dropped) differ.',
  'resetAt is the ms epoch of the last reset() call in this tab (null if never reset). When comparing two reports, both should have a resetAt so you know each was measured from a clean slate.',
];

/** 지금까지 모은 요청과 렌더를 요약한다. drain 이 false 면(주기적인 업로드) 미뤄 둔 분석을 기다리지 않고 지금까지 끝난 것만 담는다. */
export const buildReport = (monitoring: boolean, now = Date.now(), drain = true): RdxReport => {
  // 사용자가 직접 묻는 조회는 미뤄 둔 분석을 먼저 마친다.
  if (drain) {
    queueIndex(); // 모든 기록의 색인 일을 큐에 올린 뒤
    flushQueue();
  }
  const records = getRecords();
  // 패널에서 "의도된 반복"으로 지정한 엔드포인트는 보고서에서도 낭비로 세지 않는다.
  const ignored = readIgnoredEndpoints();
  const classes = classifyRecords(records, ignored);
  return {
    generatedAt: new Date(now).toISOString(),
    resetAt: getResetAt(),
    page: typeof location === 'undefined' ? '' : location.pathname,
    howToRead: HOW_TO_READ,
    config: effectiveConfig(ignored.panel),
    requests: buildRequestSection(records, classes, ignored, drain ? queryContextOf : knownQueryContextOf),
    reactQuery: buildReactQuerySection(records, classes),
    renders: buildRenderSection(monitoring, now),
    diagnostics: buildDiagnostics(),
  };
};
