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
  waste: 'requests.endpoints 는 낭비(duplicates: 2초 안 같은 요청, sameResponses: 직전과 똑같은 응답) 많은 순이다.',
  review: 'review 는 주기 요청·포커스 재요청처럼 의도일 수 있지만 점검할 반복이다.',
  ignored: 'ignored: true 인 엔드포인트는 사용자가 의도된 반복으로 지정한 것이라 고치지 않는다.',
  restored: '요청 집계에는 같은 탭에서 새로고침하기 전의 요청도 들어 있다. 새로고침 전후를 가르려면 restoredCount 를 본다.',
  callers:
    'callers 는 소스맵으로 원본 위치(src/…:줄:열)로 바꾼 것이다. http 주소로 남은 줄은 소스맵이 없어 변환된 코드 기준이라 줄 번호가 어긋날 수 있으니 함수 이름으로 찾는다.',
  dropped: 'requests.dropped 가 0 보다 크면 기록 상한(200건)을 넘어 오래된 요청이 빠진 것이다. 전후 비교는 시나리오를 짧게 나눠 다시 잰다.',
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
  'failedDuplicates 는 duplicates·sameResponses 중 실패 응답(4xx·5xx, 네트워크 오류)인 수다. 코드의 낭비가 아니라 재시도나 로컬 환경(백엔드 꺼짐) 문제일 수 있어 상태 코드부터 본다.',
  'refetchReasons 는 같은 응답으로 다시 받은 React Query 재조회의 원인별 수다. stale-elapsed(staleTime 이 지나 다시 받음)·after-invalidate(무효화했지만 바뀐 것 없음)는 확인할 반복이고 낭비로 세지 않는다(review). stale-zero(staleTime 0 이라 매번 받음)는 낭비(sameResponses)에 그대로 남으니 staleTime 을 늘린다. 새로고침 전 기록과의 같은 응답은 낭비로 세지 않는다.',
  'callers 의 route 는 요청을 보낸 시점의 경로(쿼리 제외), component 는 호출 스택의 대문자 이름 함수로 짐작한 보낸 컴포넌트다. 없으면 알 수 없는 것이다.',
  'repeatCauses 는 중복(duplicates) 요청이 다시 나간 이유별 수다. deps(effect 의존성 #순번이 바뀜: 의존성 정리), remount(부모의 분기 변경으로 자식이 언마운트됐다 다시 마운트됨: 부모 분기 정리), strict(StrictMode 재실행, 고칠 것 없음). 없으면 알 수 없는 것이다.',
  'callers 의 queryKey·observer 는 React Query 가 보낸 요청의 쿼리 키와 useQuery 를 그린 컴포넌트다. noAppFrame 은 ky 의 타이머처럼 비동기 경계에서 스택이 끊겨 보낸 코드 위치를 모른다는 뜻이다(frame 은 라이브러리 내부이니 queryKey 로 찾는다).',
];
