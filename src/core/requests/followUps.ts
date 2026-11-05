import { groupBy } from '../../shared/collections.js';
import { periodicRequestIds } from './classify.js';
import { isMutating } from './methods.js';
import { endpointOf } from './requestKey.js';
import { getRecords } from './store.js';
import type { RequestRecord } from './types.js';

// 변경 요청 응답이 도착한 뒤 이만큼 안에 나간 조회를 그 요청 때문으로 본다.
const FOLLOW_UP_WINDOW_MS = 1000;

export interface FollowUp {
  endpoint: string;
  count: number;
  /** React Query 로 다시 받았으면 그 queryKey(JSON) */
  queryKey?: string;
  /** 직전과 똑같은 응답을 받은 수(무효화했지만 바뀐 게 없다). 새로고침 전 페이지의 응답과 같은 것은 세지 않는다 */
  sameResponse: number;
  /** 같은 요청이 일정한 간격으로 반복되는 중이다. 변경 때문이 아니라 폴링이 겹쳤을 수 있다. */
  periodic: boolean;
}

/** 변경 요청 하나와 그 뒤에 나간 조회 */
interface Attributed {
  mutation: RequestRecord;
  gets: RequestRecord[];
}

interface Attribution {
  byMutation: Map<number, Attributed>;
  /** 주기 반복에 든 요청 id(페이지 로드마다 한 번씩 구한 것) */
  periodic: ReadonlySet<number>;
  byId: ReadonlyMap<number, RequestRecord>;
}

const endOf = (r: RequestRecord): number => r.startedAt + r.durationMs;

/** ends(오름차순)에서 t 이하인 마지막 위치. 없으면 -1 */
const lastAtOrBefore = (ends: readonly number[], t: number): number => {
  let lo = 0;
  let hi = ends.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
};

/**
 * 조회마다 바로 앞(응답이 가장 늦게 끝난) 변경 요청 하나에만 붙인다. 두 저장의 1초 창에 함께 든 조회를 두 번 세지 않는다.
 * 페이지 로드마다 따로 보고, 새로고침 전 페이지의 기록(restored)은 몰림처럼 보지 않는다. 주기 판정도 로드마다 한 번만 한다(O(n log n)).
 */
const attribute = (records: readonly RequestRecord[]): Attribution => {
  const byMutation = new Map<number, Attributed>();
  const periodic = new Set<number>();
  groupBy(
    records.filter((r) => !r.restored),
    (r) => r.load ?? 0,
  ).forEach((group) => {
    const mutations = group.filter((r) => isMutating(r.method)).sort((a, b) => endOf(a) - endOf(b));
    if (mutations.length === 0) return;
    const ends = mutations.map(endOf);
    group.forEach((r) => {
      if (r.method.toUpperCase() !== 'GET') return;
      const i = lastAtOrBefore(ends, r.startedAt);
      if (i < 0 || r.startedAt > ends[i] + FOLLOW_UP_WINDOW_MS) return;
      const m = mutations[i];
      const entry = byMutation.get(m.id) ?? { mutation: m, gets: [] };
      entry.gets.push(r);
      byMutation.set(m.id, entry);
    });
    // 주기 반복에 든 요청만 본다. 같은 요청이 polling 중이어도 변경 뒤에 끼어든 재조회는 polling 이 아니다.
    periodicRequestIds(group).forEach((id) => periodic.add(id));
  });
  return { byMutation, periodic, byId: new Map(records.map((r) => [r.id, r])) };
};

/** 같은 응답이지만 다른 페이지 로드의 응답과 같은 것은 캐시가 비어 당연히 받은 것이다(classify 의 crossLoad 와 같은 규칙). */
const isSameResponse = (r: RequestRecord, byId: ReadonlyMap<number, RequestRecord>): boolean => {
  if (!r.sameResponseAs) return false;
  const sameAs = byId.get(r.sameResponseAs);
  return !sameAs || (sameAs.load ?? 0) === (r.load ?? 0);
};

const summarize = (gets: readonly RequestRecord[], a: Attribution, queryKeyOf: (r: RequestRecord) => string | undefined): FollowUp[] =>
  Array.from(groupBy(gets, endpointOf), ([endpoint, list]) => ({
    endpoint,
    count: list.length,
    queryKey: list.map(queryKeyOf).find((k) => k !== undefined),
    sameResponse: list.filter((r) => isSameResponse(r, a.byId)).length,
    periodic: list.some((r) => a.periodic.has(r.id)),
  })).sort((x, y) => y.count - x.count);

/**
 * 변경 요청이 아니면 빈 배열. 같은 페이지 로드 안의 조회만 보고, 근거는 시간 근접이다. queryKeyOf 는 React Query 문맥(호출하는 쪽이 넘긴다).
 * 한 조회는 바로 앞 변경 요청 하나에만 붙는다(보고서의 requests.followUps 와 같다).
 */
export const followUps = (
  mutation: RequestRecord,
  records: readonly RequestRecord[] = getRecords(),
  queryKeyOf: (r: RequestRecord) => string | undefined = () => undefined,
): FollowUp[] => {
  if (!isMutating(mutation.method) || mutation.restored) return [];
  const a = attribute(records);
  return summarize(a.byMutation.get(mutation.id)?.gets ?? [], a, queryKeyOf);
};

/** 모든 변경 요청의 뒤따른 조회를 한 번에 구한다(보고서용). 뒤따른 조회가 없는 변경 요청은 없다. */
export const allFollowUps = (
  records: readonly RequestRecord[],
  queryKeyOf: (r: RequestRecord) => string | undefined = () => undefined,
): Array<{ mutation: RequestRecord; followUps: FollowUp[] }> => {
  const a = attribute(records);
  return Array.from(a.byMutation.values(), ({ mutation, gets }) => ({ mutation, followUps: summarize(gets, a, queryKeyOf) }));
};
