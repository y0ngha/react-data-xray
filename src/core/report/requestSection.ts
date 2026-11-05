import { UNUSED_SETTLE_MS } from '../inspect/unused.js';
import type { EndpointRenders } from '../render/endpointRenders.js';
import { refetchReason, type RefetchReason } from '../reactQuery/cacheAudit.js';
import { isWaste, type RequestClass } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { callerOf } from '../requests/callerFrames.js';
import { nPlusOneRuns, type NPlusOneRun } from '../requests/nPlusOne.js';
import { endpointOf, pathOf } from '../requests/requestKey.js';
import { redactUrl } from '../requests/sessionRecords.js';
import { getDroppedCount } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { findWaterfalls, type Waterfall } from '../requests/waterfall.js';
import { queryContextOf, type QueryContext } from '../capture/queryContext.js';
import { groupBy } from '../../shared/collections.js';
import { toIgnoreMatcher, type IgnoreMatcher } from '../../shared/ignoredEndpoints.js';

const MAX_CALLERS = 3;
const MAX_EXAMPLES = 3;
const MAX_WATERFALLS = 5;

interface Caller {
  frame: string;
  count: number;
  route?: string;
  component?: string;
  /** React Query 를 거친 요청의 queryKey(JSON)와 useQuery 를 그린 컴포넌트 */
  queryKey?: string;
  observer?: string;
  /** 호출 스택에 앱 프레임이 없어 보낸 위치를 모른다 */
  noAppFrame?: true;
  /** 그중 낭비(duplicates·sameResponses)로 센 수. 0 이면 두지 않는다 */
  waste?: number;
}

export interface RequestSection {
  total: number;
  /** 기록 상한(200건)을 넘어 빠진 요청 수(reset 뒤부터) */
  dropped: number;
  endpoints: Array<{
    endpoint: string;
    /** 사용자가 의도된 반복으로 지정해 낭비로 세지 않은 엔드포인트 */
    ignored: boolean;
    count: number;
    /** 그중 새로고침 전 페이지의 요청 수 */
    restoredCount: number;
    avgMs: number;
    duplicates: number;
    sameResponses: number;
    /** 낭비(duplicates·sameResponses)로 센 것 중 실패 응답(4xx·5xx, 네트워크 오류)인 수 */
    failedDuplicates: number;
    /** 같은 응답 재조회의 React Query 원인별 수(staleTime 경과·staleTime 0·무효화 후). 알 수 있는 것만 있다 */
    refetchReasons?: Partial<Record<RefetchReason, number>>;
    review: number;
    /**
     * 이 엔드포인트의 응답이 렌더 구간(renders.windowSeconds) 안에 일으킨 렌더 수·자기 렌더 시간 합(ms, dev 빌드의 selfBaseDuration).
     * 직접 렌더와 부모를 따라 렌더된 자손을 모두 세고, viaParent 는 그중 부모를 따라 렌더된 것, fromSameResponse 는 직전과 똑같은 응답으로 일어난 것이다.
     * 원인으로 이어진 렌더가 없으면 없다. ms 는 시간 기록이 없으면 없다
     */
    renders?: EndpointRenders;
    /** 요청을 보낸 앱 코드 위치(호출 스택 앞쪽 3줄)와 그 위치에서 보낸 수. route·component 는 알 때만 있다 */
    callers: Caller[];
    /** 중복 요청이 다시 나간 이유별 수(의존성 변경·재마운트·StrictMode). 알 수 있는 것만 있다 */
    repeatCauses?: Array<{ kind: 'deps' | 'remount' | 'strict'; detail: string; count: number }>;
    /** 낭비로 판정된 요청의 URL 예(쿼리 포함) */
    wasteExamples: string[];
    /** 응답 몇 초 뒤에도 그 응답을 들고 있는 컴포넌트를 못 찾은 요청 수(확인 필요). 없으면 두지 않는다 */
    unused?: number;
    /** 그 요청의 URL 예(쿼리 포함) */
    unusedExamples?: string[];
  }>;
  /** 응답 → 마운트 → 요청으로 이어진 직렬 고리(워터폴). 지연이 큰 순으로 최대 5개, 없으면 빈 배열 */
  waterfalls: Waterfall[];
  /** 목록의 항목마다 보낸 요청(N+1) 묶음. 요청이 많은 순. 무시한 엔드포인트는 뺀다 */
  nPlusOne: NPlusOneEntry[];
}

export interface NPlusOneEntry {
  endpoint: string;
  /** 보낸 컴포넌트. 모르면 없고, 그때 묶은 기준은 location 이다 */
  component?: string;
  /** 보낸 코드 위치(첫 요청의 호출 스택 앞쪽 3줄, 소스맵으로 바꾼 것) */
  location?: string;
  /** 서로 다른 ID(경로) 수 */
  count: number;
  /** 첫 요청부터 마지막 요청까지의 시작 시각 간격(ms) */
  windowMs: number;
  /** 요청 URL 예(쿼리 포함) */
  examples: string[];
}

/** 순서는 buildReport 가 다른 섹션 줄과 맞춘다. */
export const REQUEST_HOW_TO_READ = {
  waste:
    'requests.endpoints is sorted by most waste (duplicates: same request within 2s, sameResponses: response identical to the previous one).',
  review: 'review is repetition that may be intentional — polling, focus refetch — but should be checked.',
  ignored: 'An endpoint with ignored: true was marked by the user as an expected repeat and is not counted as waste.',
  restored:
    'The request totals include requests from before a same-tab page reload. Use restoredCount to distinguish pre- and post-reload requests.',
  callers:
    'callers are resolved to original locations (src/…:line:col) via source maps. Lines that remain as http addresses have no source map and use transformed-code line numbers, which may be off — find them by function name instead.',
  dropped:
    'When requests.dropped is greater than 0, the record limit (200) was exceeded and older requests were dropped. Split the scenario into shorter segments and measure again.',
};

/**
 * 같은 호출 위치(frame)에서 보낸 것끼리 센다. route·component·queryKey 로 더 쪼개면 상위 3 자르기가 순위를 왜곡하므로 첫 기록의 것을 붙인다.
 * 스택이 끊겨 frame 이 라이브러리 내부인 요청은 호출한 곳을 queryKey 로 가른다.
 */
const callersOf = (
  records: readonly RequestRecord[],
  queryOf: (record: RequestRecord) => QueryContext | undefined,
  wasted: (record: RequestRecord) => boolean,
) => {
  const counts = records.reduce((acc, r) => {
    const frame = callerOf(r.sourceStack ?? r.stack);
    const query = queryOf(r);
    const component = r.component ?? query?.observer; // 스택으로 모르면 useQuery 를 그린 컴포넌트가 보낸 곳이다
    if (!frame && !query) return acc;
    const key = JSON.stringify([frame, !!r.noAppFrame, r.noAppFrame || !frame ? query?.queryKey : undefined]);
    const caller: Caller = acc.get(key) ?? {
      frame: frame ?? '',
      count: 0,
      ...(r.route !== undefined && { route: r.route }),
      ...(component && { component }),
      ...(query && { queryKey: query.queryKey, ...(query.observer && { observer: query.observer }) }),
      ...(r.noAppFrame && { noAppFrame: true as const }),
    };
    return acc.set(key, { ...caller, count: caller.count + 1, ...(wasted(r) && { waste: (caller.waste ?? 0) + 1 }) });
  }, new Map<string, Caller>());
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CALLERS);
};

/** 같은 응답으로 분류된(낭비·확인 필요) 재조회의 원인별 수. 없으면 필드를 두지 않는다. */
const refetchReasonsOf = (own: readonly RequestRecord[], classes: ReadonlyMap<number, RequestClass>) => {
  const counts: Partial<Record<RefetchReason, number>> = {};
  own
    .filter((r) => r.sameResponseAs !== undefined && !r.duplicateOf)
    .forEach((r) => {
      const c = classes.get(r.id);
      const reason = c === 'same-response' || c === 'stale-elapsed' || c === 'after-invalidate' ? refetchReason(r) : undefined;
      if (reason) counts[reason] = (counts[reason] ?? 0) + 1;
    });
  return Object.keys(counts).length > 0 ? counts : undefined;
};

const repeatCausesOf = (own: readonly RequestRecord[]) => {
  const counts = new Map<string, { kind: 'deps' | 'remount' | 'strict'; detail: string; count: number }>();
  own.forEach((r) => {
    if (!r.repeatCause) return;
    const key = `${r.repeatCause.kind}|${r.repeatCause.detail}`;
    counts.set(key, { ...r.repeatCause, count: (counts.get(key)?.count ?? 0) + 1 });
  });
  return counts.size > 0
    ? Array.from(counts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_CALLERS)
    : undefined;
};

/** 쓰지 않는 응답의 수와 URL 예. 없으면 필드를 두지 않는다. */
const unusedOf = (own: readonly RequestRecord[]): { unused?: number; unusedExamples?: string[] } => {
  const unused = own.filter((r) => r.unused);
  return unused.length > 0
    ? { unused: unused.length, unusedExamples: Array.from(new Set(unused.map((r) => redactUrl(r.url)))).slice(0, MAX_EXAMPLES) }
    : {};
};

const nPlusOneEntryOf = (run: NPlusOneRun): NPlusOneEntry => {
  const first = run.records[0];
  const location = callerOf(first.sourceStack ?? first.stack);
  return {
    endpoint: run.endpoint,
    ...(run.component && { component: run.component }),
    ...(location && { location }),
    count: run.distinct,
    windowMs: (run.records.at(-1)?.startedAt ?? first.startedAt) - first.startedAt,
    // 같은 ID 의 다른 쿼리는 예로 겹쳐 싣지 않는다
    examples: [...new Map(run.records.map((r) => [pathOf(r.url), r.url])).values()].slice(0, MAX_EXAMPLES).map(redactUrl),
  };
};

/**
 * queryOf 는 요청의 React Query 문맥을 찾는 함수다. 기본은 fiber 트리를 걸어 찾는다(사용자가 요청한 보고서).
 * 5초 주기 업로드처럼 앱 경로 가까이서 돌 때는 knownQueryContextOf 를 넘겨 이미 찾아 둔 것만 쓴다.
 */
export const buildRequestSection = (
  records: readonly RequestRecord[],
  classes: ReadonlyMap<number, RequestClass>,
  ignored: IgnoreMatcher | ReadonlySet<string>,
  queryOf: (record: RequestRecord) => QueryContext | undefined = queryContextOf,
  /** 엔드포인트별 렌더 비용(render/monitor 의 getEndpointRenders). 렌더 감시가 꺼져 있었으면 비어 있다 */
  renders: ReadonlyMap<string, EndpointRenders> = new Map(),
): RequestSection => {
  const byEndpoint = groupBy(records, endpointOf);
  const matcher = toIgnoreMatcher(ignored);
  return {
    total: records.length,
    dropped: getDroppedCount(),
    endpoints: getEndpointStats(records, classes).map((s) => {
      const own = byEndpoint.get(s.endpoint) ?? [];
      return Object.assign(
        {
          endpoint: s.endpoint,
          ignored: !!matcher.sourceOf(s.endpoint),
          count: s.count,
          restoredCount: own.filter((r) => r.restored).length,
          avgMs: s.avgMs,
          duplicates: s.duplicates,
          sameResponses: s.sameResponses,
          failedDuplicates: s.failedDuplicates ?? 0,
          refetchReasons: refetchReasonsOf(own, classes),
          review: s.review,
          renders: renders.get(s.endpoint),
          callers: callersOf(own, queryOf, (r) => isWaste(classes.get(r.id))),
          repeatCauses: repeatCausesOf(own),
          wasteExamples: Array.from(new Set(own.filter((r) => isWaste(classes.get(r.id))).map((r) => redactUrl(r.url)))).slice(
            0,
            MAX_EXAMPLES,
          ),
        },
        unusedOf(own),
      );
    }),
    nPlusOne: nPlusOneRuns(records)
      .filter((run) => !matcher.sourceOf(run.endpoint))
      .map(nPlusOneEntryOf),
    waterfalls: findWaterfalls(records, (r) => callerOf(r.sourceStack ?? r.stack)).slice(0, MAX_WATERFALLS),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REQUEST_HOW_TO_READ_EXTRA: readonly string[] = [
  'The 2s duplicate window and the 200-record limit above are defaults; the values in effect are config.dedupeWindowMs and config.maxRecords. ignored: true also covers endpoints in config.ignore (set in code with configure(), not removable in the panel).',
  'failedDuplicates is the count of duplicates and sameResponses that were failed responses (4xx, 5xx, or network error). These may be retries or a local environment issue (backend down) rather than code waste — check the status code first.',
  'refetchReasons is a breakdown by cause of React Query refetches that received the same response. stale-elapsed (refetched after staleTime expired) and after-invalidate (invalidated but response unchanged) are repeats to review but are not counted as waste. stale-zero (staleTime is 0, so fetched every time) stays in sameResponses as waste — increase staleTime. Same-response matches against pre-reload records are not counted as waste.',
  "callers.waste is how many of that caller's requests were counted as waste (duplicates or sameResponses); absent when none. summary points at the listed caller with the most waste.",
  'callers.route is the path (no query string) at the time the request was sent; component is the sending component guessed from the first capitalized function name in the call stack. Absent when unknown.',
  'repeatCauses is a breakdown by reason why duplicate requests were re-issued. deps: an effect dependency at the given index changed (fix: clean up dependencies); remount: a parent branch change unmounted and remounted the child (fix: stabilize the parent branch); strict: StrictMode re-ran the effect (nothing to fix). Absent when unknown.',
  'requests.nPlusOne lists requests sent once per list item (N+1): config.nPlusOne.count (default 5)+ requests for different IDs to the same endpoint (an :id path segment) from the same component (or, when the component is unknown, the same caller location) within config.nPlusOne.windowMs (default 1000). count is the number of different IDs (paths), windowMs the time from the first to the last request, examples a few URLs (one per ID). Ignored endpoints are left out. Repeats of the same ID are duplicates and are not included. It is review (may be intended, e.g. a virtualized list), not waste: fetch them in one request from the list (batch endpoint, include/expand) or fetch once in the parent.',
  'requests.waterfalls lists serial request chains (up to 5, largest latency first): the response of chain[i] caused the commit in which chain[i+1].component mounted, and that component sent chain[i+1] right after (from its effect). Requests sent in parallel are not chained. depth is the number of requests in the chain, latencyMs is the sum of chain[].ms (the wait added by running them one after another), location is where each request was sent. Paths with the same endpoints and components are grouped: chain[].ms is the average response time over all grouped paths (including several list rows behind one first request), and count is the number of distinct chains, counted by their first request. If the later request does not need the earlier response, start it in parallel or prefetch it; if it does, join the data on the server or move both into a route loader. rdx does not check whether the data is actually used.',
  `unused is how many of the endpoint's responses no component was found holding ${UNUSED_SETTLE_MS / 1000}s after they arrived (neither the same object nor a derived copy with matching field values; earlier responses of the same request count as held), with unusedExamples as their URLs. Only successful, non-empty JSON responses of non-mutating requests (not POST, PUT, PATCH, DELETE) on endpoints that are not ignored are judged, once each. It needs review rather than being waste: data used only inside effects or event handlers, or transformed into new objects, also looks unused — confirm in code that nothing reads it before removing or deferring the request. summary lists such endpoints as kind unused-response with severity medium. Absent when none.`,
  'callers.queryKey and callers.observer are the query key and the component rendering the useQuery call for React Query requests. noAppFrame means the call stack was broken at an async boundary (like a timer in ky) and the sending location is unknown — use queryKey to identify it (frame is a library internal).',
  'requests.endpoints[].renders is what responses from this endpoint caused on screen during renders.windowSeconds: count renders and ms self render time, including both components that received the response (direct, or own state changed right after it arrived) and descendants that rendered along with them; viaParent is the portion that rendered only because an ancestor did (fix that ancestor, or memoize the children). fromSameResponse is the portion caused by a response identical to the previous one — pure waste that disappears when the refetch is removed or setState is skipped for an unchanged response; summary.topFindings[].savings.renders and renderMs for that endpoint come from it. ms is a selfBaseDuration sum from a dev build: compare it across endpoints or before vs. after a fix rather than reading it as production time; each ms is absent when none of the renders in that part had timing. Renders are counted over the same instances as renders.components (when renders.truncated is true, the dropped instances are not counted either) and only for requests still in the record (see requests.dropped). Absent when no render was linked to the endpoint.',
];
