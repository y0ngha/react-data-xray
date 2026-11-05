import { refetchReason, type RefetchReason } from '../reactQuery/cacheAudit.js';
import { isWaste, type RequestClass } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
import { callerOf } from '../requests/callerFrames.js';
import { N_PLUS_ONE_MIN, N_PLUS_ONE_WINDOW_MS, nPlusOneRuns, type NPlusOneRun } from '../requests/nPlusOne.js';
import { endpointOf } from '../requests/requestKey.js';
import { redactUrl } from '../requests/sessionRecords.js';
import { getDroppedCount } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { queryContextOf, type QueryContext } from '../capture/queryContext.js';
import { groupBy } from '../../shared/collections.js';

const MAX_CALLERS = 3;
const MAX_EXAMPLES = 3;

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
    /** 요청을 보낸 앱 코드 위치(호출 스택 앞쪽 3줄)와 그 위치에서 보낸 수. route·component 는 알 때만 있다 */
    callers: Caller[];
    /** 중복 요청이 다시 나간 이유별 수(의존성 변경·재마운트·StrictMode). 알 수 있는 것만 있다 */
    repeatCauses?: Array<{ kind: 'deps' | 'remount' | 'strict'; detail: string; count: number }>;
    /** 낭비로 판정된 요청의 URL 예(쿼리 포함) */
    wasteExamples: string[];
  }>;
  /** 목록의 항목마다 보낸 요청(N+1) 묶음. 요청이 많은 순. 무시한 엔드포인트는 뺀다 */
  nPlusOne: NPlusOneEntry[];
}

export interface NPlusOneEntry {
  endpoint: string;
  /** 보낸 컴포넌트. 모르면 없고, 그때 묶은 기준은 location 이다 */
  component?: string;
  /** 보낸 코드 위치(첫 요청의 호출 스택 앞쪽 3줄, 소스맵으로 바꾼 것) */
  location?: string;
  /** 서로 다른 ID 로 나간 요청 수 */
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

const nPlusOneEntryOf = (run: NPlusOneRun): NPlusOneEntry => {
  const first = run.records[0];
  const location = callerOf(first.sourceStack ?? first.stack);
  return {
    endpoint: run.endpoint,
    ...(run.component && { component: run.component }),
    ...(location && { location }),
    count: run.records.length,
    windowMs: (run.records.at(-1)?.startedAt ?? first.startedAt) - first.startedAt,
    examples: run.records.slice(0, MAX_EXAMPLES).map((r) => redactUrl(r.url)),
  };
};

/**
 * queryOf 는 요청의 React Query 문맥을 찾는 함수다. 기본은 fiber 트리를 걸어 찾는다(사용자가 요청한 보고서).
 * 5초 주기 업로드처럼 앱 경로 가까이서 돌 때는 knownQueryContextOf 를 넘겨 이미 찾아 둔 것만 쓴다.
 */
export const buildRequestSection = (
  records: readonly RequestRecord[],
  classes: ReadonlyMap<number, RequestClass>,
  ignored: ReadonlySet<string>,
  queryOf: (record: RequestRecord) => QueryContext | undefined = queryContextOf,
): RequestSection => {
  const byEndpoint = groupBy(records, endpointOf);
  return {
    total: records.length,
    dropped: getDroppedCount(),
    endpoints: getEndpointStats(records, classes).map((s) => {
      const own = byEndpoint.get(s.endpoint) ?? [];
      return {
        endpoint: s.endpoint,
        ignored: ignored.has(s.endpoint),
        count: s.count,
        restoredCount: own.filter((r) => r.restored).length,
        avgMs: s.avgMs,
        duplicates: s.duplicates,
        sameResponses: s.sameResponses,
        failedDuplicates: s.failedDuplicates ?? 0,
        refetchReasons: refetchReasonsOf(own, classes),
        review: s.review,
        callers: callersOf(own, queryOf, (r) => isWaste(classes.get(r.id))),
        repeatCauses: repeatCausesOf(own),
        wasteExamples: Array.from(new Set(own.filter((r) => isWaste(classes.get(r.id))).map((r) => redactUrl(r.url)))).slice(
          0,
          MAX_EXAMPLES,
        ),
      };
    }),
    nPlusOne: nPlusOneRuns(records)
      .filter((run) => !ignored.has(run.endpoint))
      .map(nPlusOneEntryOf),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REQUEST_HOW_TO_READ_EXTRA: readonly string[] = [
  'failedDuplicates is the count of duplicates and sameResponses that were failed responses (4xx, 5xx, or network error). These may be retries or a local environment issue (backend down) rather than code waste — check the status code first.',
  'refetchReasons is a breakdown by cause of React Query refetches that received the same response. stale-elapsed (refetched after staleTime expired) and after-invalidate (invalidated but response unchanged) are repeats to review but are not counted as waste. stale-zero (staleTime is 0, so fetched every time) stays in sameResponses as waste — increase staleTime. Same-response matches against pre-reload records are not counted as waste.',
  "callers.waste is how many of that caller's requests were counted as waste (duplicates or sameResponses); absent when none. summary points at the listed caller with the most waste.",
  'callers.route is the path (no query string) at the time the request was sent; component is the sending component guessed from the first capitalized function name in the call stack. Absent when unknown.',
  'repeatCauses is a breakdown by reason why duplicate requests were re-issued. deps: an effect dependency at the given index changed (fix: clean up dependencies); remount: a parent branch change unmounted and remounted the child (fix: stabilize the parent branch); strict: StrictMode re-ran the effect (nothing to fix). Absent when unknown.',
  `requests.nPlusOne lists requests sent once per list item (N+1): ${N_PLUS_ONE_MIN}+ requests for different IDs to the same endpoint (IDs masked as :id) from the same component (or, when the component is unknown, the same caller location) within ${N_PLUS_ONE_WINDOW_MS / 1000}s. count is the number of such requests, windowMs the time from the first to the last, examples a few URLs. Repeats of the same ID are duplicates and are not included. It is review (may be intended, e.g. a virtualized list), not waste: fetch them in one request from the list (batch endpoint, include/expand) or fetch once in the parent.`,
  'callers.queryKey and callers.observer are the query key and the component rendering the useQuery call for React Query requests. noAppFrame means the call stack was broken at an async boundary (like a timer in ky) and the sending location is unknown — use queryKey to identify it (frame is a library internal).',
];
