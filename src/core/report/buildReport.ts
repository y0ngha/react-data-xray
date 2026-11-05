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

/** HOW_TO_READ 문구를 바꾸면 올린다(1: summary 전, 2: summary 를 먼저 읽으라는 줄을 더함 #70, 3: diagnostics 줄(#100)과 합침, 4: config 줄과 설정 안내 줄(#78), 5: requests.nPlusOne 줄(#85)). */
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
  'Check diagnostics.problems first: if rdx was loaded after react-dom (renderHook.commitsSeen is 0) or requests went out before it loaded (capture.requestsBeforeInstall), the rest of the report is incomplete. Each problem says how to fix it.',
  'config is the detection settings in effect (configure() in code, or the defaults): ignore (endpoints not counted as waste: code = configure() names and /RegExp/ strings, panel = chosen in the panel), keyHeaders (request headers that are part of the request identity), dedupeWindowMs, burst (windowMs, count), nPlusOne (windowMs, count), maxRecords, reportPath. compare warns when the detection criteria (dedupeWindowMs, burst, nPlusOne, keyHeaders, ignore, and maxRecords when requests were dropped) differ.',
  'resetAt is the ms epoch of the last reset() call in this tab (null if never reset). When comparing two reports, both should have a resetAt so you know each was measured from a clean slate.',
  'howToReadVersion is the version of these lines. If you already read this version, call window.__RDX__.report({ howToRead: false }) to leave them out.',
];

/** 지금까지 모은 요청과 렌더를 요약한다. drain 이 false 면(주기적인 업로드) 미뤄 둔 분석을 기다리지 않고 지금까지 끝난 것만 담는다. */
export const buildReport = (monitoring: boolean, now = Date.now(), drain = true, options: ReportOptions = {}): RdxReport => {
  // 사용자가 직접 묻는 조회는 미뤄 둔 분석을 먼저 마친다.
  if (drain) {
    queueIndex(); // 모든 기록의 색인 일을 큐에 올린 뒤
    flushQueue();
  }
  const records = getRecords();
  // 패널에서 "의도된 반복"으로 지정한 엔드포인트는 보고서에서도 낭비로 세지 않는다.
  const ignored = readIgnoredEndpoints();
  const classes = classifyRecords(records, ignored);
  const requests = buildRequestSection(records, classes, ignored, drain ? queryContextOf : knownQueryContextOf);
  const reactQuery = buildReactQuerySection(records, classes);
  const renders = buildRenderSection(monitoring, now);
  return {
    // 순위만 매긴다: 위 섹션이 이미 계산한 값과, 배지가 쓰는 렌더 폭주 기준(core/problems.ts)
    summary: buildSummary(requests, reactQuery, renders, findRenderStorms(now)),
    howToReadVersion: HOW_TO_READ_VERSION,
    ...(options.howToRead !== false && { howToRead: [...HOW_TO_READ] }),
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
