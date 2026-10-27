import { needsReview, type RequestClass } from './classify.js';
import { endpointOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

export interface EndpointStat {
  endpoint: string;
  count: number;
  /** 낭비로 판정된 중복 요청 */
  duplicates: number;
  /** 낭비로 판정된 같은 응답 재요청 */
  sameResponses: number;
  /** 주기 요청·포커스 재요청처럼 의도된 듯하지만 점검할 만한 반복 */
  review: number;
  /** StrictMode·재연결·무시처럼 이유가 확실한 반복 */
  explained: number;
  avgMs: number;
}

const emptyStat = (endpoint: string): EndpointStat & { totalMs: number } => ({
  endpoint,
  count: 0,
  duplicates: 0,
  sameResponses: 0,
  review: 0,
  explained: 0,
  avgMs: 0,
  totalMs: 0,
});

const tally = (stat: EndpointStat & { totalMs: number }, durationMs: number, c: RequestClass | undefined) => ({
  ...stat,
  count: stat.count + 1,
  totalMs: stat.totalMs + durationMs,
  duplicates: stat.duplicates + (c === 'duplicate' ? 1 : 0),
  sameResponses: stat.sameResponses + (c === 'same-response' ? 1 : 0),
  review: stat.review + (needsReview(c) ? 1 : 0),
  explained: stat.explained + (c === 'strict-mode' || c === 'reconnect-refetch' || c === 'ignored' ? 1 : 0),
});

export const wasteCount = (stat: EndpointStat): number => stat.duplicates + stat.sameResponses;

export const isWastefulStat = (stat: EndpointStat | undefined): boolean => !!stat && wasteCount(stat) > 0;

/**
 * 엔드포인트별 호출 수와 낭비 지표. 낭비가 많은 순, 그다음 호출이 많은 순.
 * keyOf 를 requestKeyOf 로 주면 같은 요청(쿼리·본문까지 같은 것)별로 센다(박스 라벨용).
 */
export const getEndpointStats = (
  records: readonly RequestRecord[],
  classes: ReadonlyMap<number, RequestClass>,
  keyOf: (record: RequestRecord) => string = endpointOf,
): EndpointStat[] => {
  const byEndpoint = records.reduce((acc, r) => {
    const endpoint = keyOf(r);
    return acc.set(endpoint, tally(acc.get(endpoint) ?? emptyStat(endpoint), r.durationMs, classes.get(r.id)));
  }, new Map<string, EndpointStat & { totalMs: number }>());
  return Array.from(byEndpoint.values(), ({ totalMs, ...stat }): EndpointStat =>
    Object.assign(stat, { avgMs: Math.round(totalMs / stat.count) }),
  ).sort((a, b) => wasteCount(b) - wasteCount(a) || b.count - a.count);
};

/** 박스 라벨에 붙이는 짧은 지표: "×6 · 중복 2 · 같은 응답 3". 한 번만 불렸고 낭비도 없으면 빈 문자열 */
export const statSummary = (stat: EndpointStat | undefined): string => {
  if (!stat || (stat.count <= 1 && wasteCount(stat) === 0)) return '';
  return [`×${stat.count}`, stat.duplicates > 0 && `중복 ${stat.duplicates}`, stat.sameResponses > 0 && `같은 응답 ${stat.sameResponses}`]
    .filter(Boolean)
    .join(' · ');
};
