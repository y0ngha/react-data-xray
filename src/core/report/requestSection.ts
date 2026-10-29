import { refetchReason, type RefetchReason } from '../reactQuery/cacheAudit.js';
import { isWaste, type RequestClass } from '../requests/classify.js';
import { getEndpointStats } from '../requests/endpointStats.js';
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

// 첫 줄은 대개 앱의 공통 fetch 함수라 그것만으로는 어디서 보냈는지 모른다. 바깥으로 몇 줄 더 본다.
const CALLER_FRAMES = 3;

/** 호출 스택의 앞쪽 몇 줄(rdx 프레임은 기록할 때 이미 뺐다) */
const callerOf = (stack: string | undefined): string | undefined =>
  stack
    ?.split('\n')
    .map((line) => line.trim())
    // V8: "at fn (url:1:2)", Firefox·Safari: "fn@url:1:2"
    .filter((line) => line.startsWith('at ') || /@.+:\d+:\d+$/.test(line))
    .slice(0, CALLER_FRAMES)
    // dev 서버가 파일을 고칠 때마다 붙이는 ?t=·?v= 를 뗀다. 그래야 같은 호출 위치가 고칠 때마다 갈라지지 않는다.
    .map((line) => line.replace(/\?[^\s:)]*(?=:\d+:\d+)/g, ''))
    .join(' <- ') || undefined;

/**
 * 같은 호출 위치(frame)에서 보낸 것끼리 센다. route·component·queryKey 로 더 쪼개면 상위 3 자르기가 순위를 왜곡하므로 첫 기록의 것을 붙인다.
 * 스택이 끊겨 frame 이 라이브러리 내부인 요청은 호출한 곳을 queryKey 로 가른다.
 */
const callersOf = (records: readonly RequestRecord[], queryOf: (record: RequestRecord) => QueryContext | undefined) => {
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
    return acc.set(key, { ...caller, count: caller.count + 1 });
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
        callers: callersOf(own, queryOf),
        repeatCauses: repeatCausesOf(own),
        wasteExamples: Array.from(new Set(own.filter((r) => isWaste(classes.get(r.id))).map((r) => redactUrl(r.url)))).slice(
          0,
          MAX_EXAMPLES,
        ),
      };
    }),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REQUEST_HOW_TO_READ_EXTRA: readonly string[] = [
  'failedDuplicates is the count of duplicates and sameResponses that were failed responses (4xx, 5xx, or network error). These may be retries or a local environment issue (backend down) rather than code waste — check the status code first.',
  'refetchReasons is a breakdown by cause of React Query refetches that received the same response. stale-elapsed (refetched after staleTime expired) and after-invalidate (invalidated but response unchanged) are repeats to review but are not counted as waste. stale-zero (staleTime is 0, so fetched every time) stays in sameResponses as waste — increase staleTime. Same-response matches against pre-reload records are not counted as waste.',
  'callers.route is the path (no query string) at the time the request was sent; component is the sending component guessed from the first capitalized function name in the call stack. Absent when unknown.',
  'repeatCauses is a breakdown by reason why duplicate requests were re-issued. deps: an effect dependency at the given index changed (fix: clean up dependencies); remount: a parent branch change unmounted and remounted the child (fix: stabilize the parent branch); strict: StrictMode re-ran the effect (nothing to fix). Absent when unknown.',
  'callers.queryKey and callers.observer are the query key and the component rendering the useQuery call for React Query requests. noAppFrame means the call stack was broken at an async boundary (like a timer in ky) and the sending location is unknown — use queryKey to identify it (frame is a library internal).',
];
