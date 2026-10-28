import { isFailed, isWaste, needsReview, type RequestClass } from './classify.js';
import { endpointOf, pathOf } from './requestKey.js';
import { groupBy } from '../../shared/collections.js';
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
  /** 새로고침 전 페이지에서 되살린 요청 수. 없으면 비운다 */
  restoredCount?: number;
  /** ID 조각이 묶여 서로 다른 경로가 둘 이상 모인 경우 그 경로 수 */
  idVariants?: number;
  /** 낭비로 판정된 요청 중 실패 응답(4xx·5xx, 네트워크 오류)인 것. 분류와 낭비 수는 그대로 둔다 */
  failedDuplicates?: number;
  /** 실패한 요청(낭비 여부와 무관)의 상태 코드(네트워크 오류는 'ERR'), 많이 나온 순 */
  failedCodes?: string[];
  /** 요청을 보낸 경로·컴포넌트별 건수, 많은 순. 경로도 컴포넌트도 모르는 요청은 뺀다 */
  sites?: EndpointSite[];
}

export interface EndpointSite {
  route?: string;
  component?: string;
  count: number;
}

/** 경로·컴포넌트 조합별 건수, 많은 순 */
export const sitesOf = (records: readonly RequestRecord[]): EndpointSite[] =>
  Array.from(
    records
      .filter((r) => r.route !== undefined || r.component !== undefined)
      .reduce((acc, r) => {
        const key = JSON.stringify([r.route, r.component]);
        const site = acc.get(key) ?? { route: r.route, component: r.component, count: 0 };
        return acc.set(key, { ...site, count: site.count + 1 });
      }, new Map<string, EndpointSite>())
      .values(),
  ).sort((a, b) => b.count - a.count);

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

const tally = (stat: EndpointStat & { totalMs: number }, r: RequestRecord, c: RequestClass | undefined) => ({
  ...stat,
  count: stat.count + 1,
  totalMs: stat.totalMs + r.durationMs,
  ...(r.restored ? { restoredCount: (stat.restoredCount ?? 0) + 1 } : {}),
  duplicates: stat.duplicates + (c === 'duplicate' ? 1 : 0),
  sameResponses: stat.sameResponses + (c === 'same-response' ? 1 : 0),
  review: stat.review + (needsReview(c) ? 1 : 0),
  explained: stat.explained + (c === 'strict-mode' || c === 'reconnect-refetch' || c === 'ignored' ? 1 : 0),
  ...(isWaste(c) && isFailed(r) ? { failedDuplicates: (stat.failedDuplicates ?? 0) + 1 } : {}),
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
  // 키 계산(URL 파싱)은 기록마다 한 번만 한다.
  const keys = new Map(records.map((r) => [r, keyOf(r)]));
  const keyed = (r: RequestRecord): string => keys.get(r) ?? keyOf(r);
  const byEndpoint = records.reduce((acc, r) => {
    const endpoint = keyed(r);
    return acc.set(endpoint, tally(acc.get(endpoint) ?? emptyStat(endpoint), r, classes.get(r.id)));
  }, new Map<string, EndpointStat & { totalMs: number }>());
  const pathsByEndpoint = records.reduce((acc, r) => {
    const endpoint = keyed(r);
    return endpoint.includes(':id') ? acc.set(endpoint, (acc.get(endpoint) ?? new Set<string>()).add(pathOf(r.url))) : acc;
  }, new Map<string, Set<string>>());
  const failedCodesByEndpoint = new Map(
    Array.from(
      records.filter(isFailed).reduce((acc, r) => {
        const code = r.error ? 'ERR' : String(r.status);
        const endpoint = keyed(r);
        const counts = acc.get(endpoint) ?? new Map<string, number>();
        return acc.set(endpoint, counts.set(code, (counts.get(code) ?? 0) + 1));
      }, new Map<string, Map<string, number>>()),
      ([endpoint, counts]) =>
        [
          endpoint,
          Array.from(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([code]) => code),
        ] as const,
    ),
  );
  const recordsByEndpoint = groupBy(records, keyed);
  return Array.from(byEndpoint.values(), ({ totalMs, ...stat }): EndpointStat => {
    const variants = pathsByEndpoint.get(stat.endpoint)?.size ?? 0;
    const codes = failedCodesByEndpoint.get(stat.endpoint);
    const sites = sitesOf(recordsByEndpoint.get(stat.endpoint) ?? []);
    return Object.assign(
      stat,
      { avgMs: Math.round(totalMs / stat.count) },
      variants > 1 ? { idVariants: variants } : {},
      codes ? { failedCodes: codes } : {},
      sites.length > 0 ? { sites } : {},
    );
  }).sort((a, b) => wasteCount(b) - wasteCount(a) || b.count - a.count);
};

/** 박스 라벨에 붙이는 짧은 지표: "×6 · 중복 2 · 같은 응답 3". 한 번만 불렸고 낭비도 없으면 빈 문자열 */
export const statSummary = (stat: EndpointStat | undefined): string => {
  if (!stat || (stat.count <= 1 && wasteCount(stat) === 0)) return '';
  return [`×${stat.count}`, stat.duplicates > 0 && `중복 ${stat.duplicates}`, stat.sameResponses > 0 && `같은 응답 ${stat.sameResponses}`]
    .filter(Boolean)
    .join(' · ');
};
