import { groupBy } from '../../shared/collections.js';
import { isPeriodic } from './classify.js';
import { endpointOf, requestKeyOf } from './requestKey.js';
import { getRecords } from './store.js';
import type { RequestRecord } from './types.js';

// 변경 요청 응답이 도착한 뒤 이만큼 안에 나간 조회를 그 요청 때문으로 본다.
const FOLLOW_UP_WINDOW_MS = 1000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface FollowUp {
  endpoint: string;
  count: number;
  /** React Query 로 다시 받았으면 그 queryKey(JSON) */
  queryKey?: string;
  /** 직전과 똑같은 응답을 받은 수(무효화했지만 바뀐 게 없다) */
  sameResponse: number;
  /** 같은 요청이 일정한 간격으로 반복되는 중이다. 변경 때문이 아니라 폴링이 겹쳤을 수 있다. */
  periodic: boolean;
}

/** 변경 요청이 아니면 빈 배열. 같은 페이지 로드 안의 조회만 보고, 근거는 시간 근접이다. queryKeyOf 는 React Query 문맥(호출하는 쪽이 넘긴다). */
export const followUps = (
  mutation: RequestRecord,
  records: readonly RequestRecord[] = getRecords(),
  queryKeyOf: (r: RequestRecord) => string | undefined = () => undefined,
): FollowUp[] => {
  if (!MUTATING.has(mutation.method.toUpperCase())) return [];
  const from = mutation.startedAt + mutation.durationMs;
  const load = mutation.load ?? 0;
  const sameLoad = records.filter((r) => (r.load ?? 0) === load);
  const after = sameLoad.filter(
    (r) => r.method.toUpperCase() === 'GET' && r.startedAt >= from && r.startedAt <= from + FOLLOW_UP_WINDOW_MS,
  );
  const startsOf = groupBy(sameLoad, requestKeyOf);
  return Array.from(groupBy(after, endpointOf), ([endpoint, list]) => ({
    endpoint,
    count: list.length,
    ...(() => {
      const queryKey = list.map(queryKeyOf).find((k) => k !== undefined);
      return queryKey === undefined ? {} : { queryKey };
    })(),
    sameResponse: list.filter((r) => r.sameResponseAs).length,
    periodic: list.some((r) => isPeriodic((startsOf.get(requestKeyOf(r)) ?? []).map((x) => x.startedAt))),
  })).sort((a, b) => b.count - a.count);
};
