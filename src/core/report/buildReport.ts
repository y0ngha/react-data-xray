import { effectiveConfig, type EffectiveConfig } from '../config.js';
import { knownQueryContextOf, queryContextOf } from '../capture/queryContext.js';
import { queueIndex } from '../inspect/derivedMatch.js';
import { areSourcesResolved } from '../capture/requestContext.js';
import { isQueryContextChecked } from '../capture/queryContext.js';
import { flushQueue, pendingSteps } from '../scheduler/idleQueue.js';
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
import { buildSummary, SUMMARY_HOW_TO_READ, type ReportSummary } from './summarySection.js';
import { findRenderStorms } from '../problems.js';

/** AI·사람이 읽는 rdx 결과 요약. 응답 본문과 헤더는 넣지 않는다(인증 정보가 섞일 수 있다). */
export interface RdxReport {
  /** 고칠 것의 순위와 한 줄 판정. 보고서를 읽는 쪽이 가장 먼저 본다 */
  summary: ReportSummary;
  /** howToRead 문구의 판. 문구를 바꾸면 올린다. howToRead 를 뺀 보고서도 이 값은 남는다 */
  howToReadVersion: number;
  /** 필드를 읽는 법. report({ howToRead: false }) 로 뺄 수 있다 */
  howToRead?: string[];
  /**
   * 보고서에 들어갈 분석이 다 끝났는지(incompleteReasons 가 비었는지). 5초 주기 파일(.rdx/report.json)은 큐를 비우지도
   * 소스맵을 기다리지도 queryKey 를 찾지도 않아 false 일 수 있다. snapshot() 은 큐를 비우고 소스맵을 2초까지 기다린다
   */
  complete: boolean;
  /** complete 가 false 인 이유 */
  incompleteReasons: IncompleteReason[];
  /** 보고서를 만든 때 유휴 큐에 남은 보고서용 분석 step 수(화면만 쓰는 step 은 세지 않는다) */
  pendingAnalysis: number;
  /** 보고서를 만든 때 진행 중인 소스맵 변환이 없었는지. false 면 callers 일부가 변환 전 위치(http 주소)다 */
  sourcesResolved: boolean;
  /** React Query 를 쓰는 화면에서 모든 요청의 queryKey 문맥을 찾아 봤는지. 주기 파일은 찾지 않으므로 false 일 수 있다 */
  queryKeysResolved: boolean;
  generatedAt: string;
  /** 이 탭에서 마지막으로 reset 한 시각(ms). reset 한 적이 없으면 null */
  resetAt: number | null;
  page: string;
  /** configure() 로 정한(또는 기본) 판정 기준. compare 가 기준이 다른 두 보고서를 경고한다 */
  config: EffectiveConfig;
  requests: RequestSection;
  reactQuery: ReactQuerySection;
  renders: RenderSection;
  /** rdx 가 제대로 붙었는지(window.__RDX__.doctor() 와 같다). 결과를 읽기 전에 problems 를 먼저 본다 */
  diagnostics: RdxDiagnostics;
}

export interface ReportOptions {
  /** false 면 howToRead 를 싣지 않는다(이미 읽은 판이면 토큰을 아끼려고). 기본 true */
  howToRead?: boolean;
}

/**
 * pending-analysis: 큐에 보고서용 분석이 남았다. source-maps: 소스맵 변환 중이다. source-map-timeout: snapshot 이 소스맵을 2초 기다리고도
 * 끝나지 않았다. query-keys: React Query 요청의 queryKey 문맥을 아직 찾지 않았다(주기 파일)
 */
export type IncompleteReason = 'pending-analysis' | 'source-maps' | 'source-map-timeout' | 'query-keys';

/** buildReport 를 부르는 쪽이 아는 사정(보고서 API 용. window.__RDX__.report() 옵션이 아니다) */
export interface BuildContext {
  /** snapshot 이 소스맵 대기를 2초 상한에서 끝냈다 */
  sourceMapTimedOut?: boolean;
}

/**
 * HOW_TO_READ 문구를 바꾸면 올린다(1: summary 전, 2: summary 를 먼저 읽으라는 줄을 더함 #70, 3: diagnostics 줄(#100)과 합침,
 * 4: config 줄과 설정 안내 줄(#78), 5: complete·incompleteReasons 줄 #71).
 */
export const HOW_TO_READ_VERSION = 5;

// 섹션별 줄을 읽는 순서로 잇는다.
export const HOW_TO_READ: readonly string[] = [
  ...SUMMARY_HOW_TO_READ,
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
  'complete is false when some analysis that feeds this report had not finished; incompleteReasons says why: pending-analysis (pendingAnalysis steps still queued), source-maps (still resolving, so some callers are http addresses), source-map-timeout (snapshot waited 2s for source maps and gave up), query-keys (React Query request contexts not looked up yet). The periodic .rdx/report.json waits for none of these, and report() is a quick read that finishes the queue but does not wait for source maps. For before/after comparisons use window.__RDX__.snapshot(name), which finishes the queue and waits up to 2s for source maps, and check that its complete is true.',
  'Check diagnostics.problems first: if rdx was loaded after react-dom (renderHook.commitsSeen is 0) or requests went out before it loaded (capture.requestsBeforeInstall), the rest of the report is incomplete. Each problem says how to fix it.',
  'config is the detection settings in effect (configure() in code, or the defaults): ignore (endpoints not counted as waste: code = configure() names and /RegExp/ strings, panel = chosen in the panel), keyHeaders (request headers that are part of the request identity), dedupeWindowMs, burst (windowMs, count), maxRecords, reportPath. compare warns when the detection criteria (dedupeWindowMs, burst, keyHeaders, ignore, and maxRecords when requests were dropped) differ.',
  'resetAt is the ms epoch of the last reset() call in this tab (null if never reset). When comparing two reports, both should have a resetAt so you know each was measured from a clean slate.',
  'howToReadVersion is the version of these lines. If you already read this version, call window.__RDX__.report({ howToRead: false }) to leave them out.',
];

/** 지금까지 모은 요청과 렌더를 요약한다. drain 이 false 면(주기적인 업로드) 미뤄 둔 분석을 기다리지 않고 지금까지 끝난 것만 담는다. */
export const buildReport = (
  monitoring: boolean,
  now = Date.now(),
  drain = true,
  options: ReportOptions = {},
  context: BuildContext = {},
): RdxReport => {
  // 사용자가 직접 묻는 조회는 미뤄 둔 분석을 먼저 마친다.
  if (drain) {
    queueIndex(); // 모든 기록의 색인 일을 큐에 올린 뒤
    flushQueue();
  }
  const records = getRecords();
  // 패널에서 "의도된 반복"으로 지정한 엔드포인트는 보고서에서도 낭비로 세지 않는다.
  const ignored = readIgnoredEndpoints();
  const classes = classifyRecords(records, ignored);
  // 요청 섹션(callers.queryKey)을 만들기 전에 본다. 주기 파일은 찾아 둔 문맥만 쓰므로 아직 찾아 보지 않은 요청은 queryKey 가 빠진다.
  const queryKeysKnown = drain || records.every(isQueryContextChecked);
  const requests = buildRequestSection(records, classes, ignored, drain ? queryContextOf : knownQueryContextOf);
  const reactQuery = buildReactQuerySection(records, classes);
  const renders = buildRenderSection(monitoring, now);
  // 섹션을 만든 뒤에 읽는다(만드는 동안 큐에 들어간 일도 센다). 읽기만 하고 비우지 않는다.
  const pendingAnalysis = pendingSteps();
  const sourcesResolved = areSourcesResolved();
  // 화면에 QueryClient 가 없으면 찾을 queryKey 도 없다.
  const queryKeysResolved = !reactQuery.found || queryKeysKnown;
  const incompleteReasons: IncompleteReason[] = [
    ...(pendingAnalysis > 0 ? (['pending-analysis'] as const) : []),
    ...(sourcesResolved ? [] : [context.sourceMapTimedOut ? ('source-map-timeout' as const) : ('source-maps' as const)]),
    ...(queryKeysResolved ? [] : (['query-keys'] as const)),
  ];
  return {
    // 순위만 매긴다: 위 섹션이 이미 계산한 값과, 배지가 쓰는 렌더 폭주 기준(core/problems.ts)
    summary: buildSummary(requests, reactQuery, renders, findRenderStorms(now)),
    howToReadVersion: HOW_TO_READ_VERSION,
    ...(options.howToRead !== false && { howToRead: [...HOW_TO_READ] }),
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    pendingAnalysis,
    sourcesResolved,
    queryKeysResolved,
    generatedAt: new Date(now).toISOString(),
    resetAt: getResetAt(),
    page: typeof location === 'undefined' ? '' : location.pathname,
    config: effectiveConfig(ignored.panel),
    requests,
    reactQuery,
    renders,
    diagnostics: buildDiagnostics(),
  };
};
