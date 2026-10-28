import { queryContextOf } from '../capture/queryContext.js';
import type { RequestRecord } from '../requests/types.js';
import { fetchCauseDetail, type FetchCause } from './cacheAudit.js';

export const FETCH_CAUSE_LABEL: Record<FetchCause, string> = {
  initial: '캐시 없음(첫 조회)',
  mount: '관찰자가 마운트돼 stale 이라 받음',
  enabled: '관찰자의 enabled 가 켜져 stale 이라 받음',
  invalidate: '무효화(invalidateQueries)',
  focus: '포커스·재연결',
  interval: 'refetchInterval',
};

// 같은 응답을 낭비로 다시 받았을 때만 붙인다. 무효화·첫 조회는 의도된 동작이다(#28 의 분류가 맡는다).
const FETCH_CAUSE_FIX: Partial<Record<FetchCause, string>> = {
  enabled: '`enabled` 전환마다 stale 이라 다시 받습니다. 이 관찰자에 `staleTime` 을 주거나 상위 화면의 캐시를 그대로 쓰세요.',
  mount: '마운트할 때마다 stale 이라 다시 받습니다. 이 관찰자에 `staleTime` 을 주거나 `refetchOnMount: false` 를 쓰세요.',
  focus: '포커스·재연결마다 stale 이라 다시 받습니다. `staleTime` 을 주거나 `refetchOnWindowFocus: false` 를 쓰세요.',
  interval: '`refetchInterval` 마다 같은 응답을 받습니다. 간격을 늘리거나 바뀔 때만 받게 하세요.',
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
    d.ageMs !== undefined && `마지막 갱신 ${d.ageMs}ms 전`,
    d.invalidated && '무효화됨',
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
