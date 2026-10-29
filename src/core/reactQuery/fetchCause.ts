import { queryContextOf } from '../capture/queryContext.js';
import type { RequestRecord } from '../requests/types.js';
import { fetchCauseDetail, type FetchCause } from './cacheAudit.js';

export const FETCH_CAUSE_LABEL: Record<FetchCause, string> = {
  initial: 'no cache (initial fetch)',
  mount: 'observer mounted, data stale',
  enabled: 'observer enabled, data stale',
  'key-change': 'queryKey changed, data stale',
  invalidate: 'invalidated (invalidateQueries)',
  focus: 'focus · reconnect',
  interval: 'refetchInterval',
};

// 같은 응답을 낭비로 다시 받았을 때만 붙인다. 무효화·첫 조회는 의도된 동작이다(#28 의 분류가 맡는다).
const FETCH_CAUSE_FIX: Partial<Record<FetchCause, string>> = {
  enabled: "Refetches stale data on every `enabled` toggle. Add `staleTime` to this observer or reuse the parent screen's cache.",
  mount: 'Refetches stale data on every mount. Add `staleTime` to this observer or set `refetchOnMount: false`.',
  'key-change': 'Refetches stale data on every queryKey change. Add `staleTime` to this observer or use `placeholderData` for continuity.',
  focus: 'Refetches stale data on every focus/reconnect. Add `staleTime` or set `refetchOnWindowFocus: false`.',
  interval: 'Receives the same response on every `refetchInterval`. Increase the interval or refetch only on change.',
};

export interface FetchCauseInfo {
  cause: FetchCause;
  label: string;
  queryKey: string;
  /** 관찰자(useQuery 를 그린 컴포넌트) */
  observer?: string;
  /** 판단 근거: staleTime·마지막 갱신 이후 시간·무효화 표시 */
  evidence: string;
  fix?: string;
}

/**
 * React Query 요청의 fetch 원인과 관찰자(queryContextOf, 같은 응답이면 쿼리 데이터의 첫 요청으로 찾는다).
 * wasteful 이 true(같은 응답 낭비로 분류됨)일 때만 처방을 붙인다. 사용자 조회·보고서에서 부른다.
 */
export const describeFetchCause = (record: RequestRecord, wasteful: boolean): FetchCauseInfo | undefined => {
  const d = fetchCauseDetail(record);
  if (!d) return undefined;
  const ctx = queryContextOf(record) ?? (d.dataRecord ? queryContextOf(d.dataRecord) : undefined);
  const evidence = [
    d.staleTime !== undefined && `staleTime ${d.staleTime}ms`,
    d.ageMs !== undefined && `last updated ${d.ageMs}ms ago`,
    d.invalidated && 'invalidated',
  ]
    .filter(Boolean)
    .join(' · ');
  const fix = wasteful ? FETCH_CAUSE_FIX[d.cause] : undefined;
  return {
    cause: d.cause,
    label: FETCH_CAUSE_LABEL[d.cause],
    queryKey: d.queryKey,
    ...(ctx?.observer && { observer: ctx.observer }),
    evidence,
    ...(fix && { fix }),
  };
};
