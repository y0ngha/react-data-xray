import { groupBy } from '../../shared/collections.js';
import { inFlightAtOverlap } from '../reactQuery/overlapCancel.js';
import { pinnedRefetchReason } from '../reactQuery/refetchReason.js';
import { endpointOf, requestKeyOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

/**
 * 요청 하나를 세 단계로 나눈다.
 * - 낭비(빨강): duplicate, same-response
 * - 확인 필요(노랑): periodic, focus-refetch, stale-elapsed(staleTime 이 지나 다시 받음), after-invalidate(무효화했지만 바뀐 것 없음). 의도된 동작일 가능성이 높지만, 바뀌지 않는 데이터를
 *   너무 자주 받거나 캐시 설정(staleTime)이 짧다는 신호일 수 있어 숨기지 않는다.
 * - 정상(회색): strict-mode(근거가 확실한 것만), reconnect-refetch, ignored(사용자가 지정)
 */
export type RequestClass =
  | 'duplicate'
  | 'same-response'
  | 'periodic'
  | 'strict-mode'
  | 'focus-refetch'
  | 'stale-elapsed'
  | 'after-invalidate'
  | 'reconnect-refetch'
  | 'ignored'
  | 'ok';

export const CLASS_LABEL: Record<RequestClass, string> = {
  duplicate: 'duplicate request',
  'same-response': 'same-response refetch',
  periodic: 'polling',
  'strict-mode': 'possible StrictMode',
  'focus-refetch': 'focus refetch',
  'stale-elapsed': 'refetch after stale',
  'after-invalidate': 'unchanged after invalidation',
  'reconnect-refetch': 'reconnect refetch',
  ignored: 'ignored',
  ok: '',
};

/** 4xx·5xx 응답이거나 네트워크 오류로 끝난 요청 */
export const isFailed = (r: RequestRecord): boolean => !!r.error || r.status >= 400;

export const isWaste = (c: RequestClass | undefined): boolean => c === 'duplicate' || c === 'same-response';
export const needsReview = (c: RequestClass | undefined): boolean =>
  c === 'periodic' || c === 'focus-refetch' || c === 'stale-elapsed' || c === 'after-invalidate';

const PERIODIC_MIN_COUNT = 3;
const PERIODIC_MIN_INTERVAL_MS = 1000;
// 간격이 중앙값에서 이만큼 안쪽이면 한 주기로 본다.
const PERIODIC_TOLERANCE = 0.25;
// 주기 구간에 든 요청이 같은 요청 기록의 이만큼 이상이어야 주기 요청으로 본다. 불규칙한 반복이 우연히 맞은 몇 건으로 노랑에 숨지 않게 한다.
const PERIODIC_MIN_SHARE = 0.7;

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * 같은 요청의 시작 시각 중 일정한 간격의 반복(대시보드 polling 같은 의도된 반복)에 든 것. 입력 순서대로 true/false 를 돌려준다.
 * 간격 중앙값을 주기로 보고, 시각 순으로 걸으며 직전 반복에서 한 주기(±25%) 뒤의 요청을 구간에 잇는다.
 * - 한 주기보다 훨씬 이른 요청은 사이에 끼어든 재조회라 건너뛴다(구간에 넣지 않고, 제 판정을 그대로 받는다).
 * - 한 주기보다 훨씬 늦은 요청(탭을 숨겨 polling 이 멈췄던 끊김)에서는 새 구간을 시작한다.
 * 3건 이상 이어진 구간이 있고, 2건 이상 이어진 구간에 든 요청이 기록의 70% 이상이면 그 구간의 요청이 주기다.
 * 간격이 불규칙하면 구간이 짧게 끊기고 건너뛴 요청이 많아 주기가 아니다.
 */
export const periodicStarts = (starts: readonly number[]): boolean[] => {
  const result = starts.map(() => false);
  if (starts.length < PERIODIC_MIN_COUNT) return result;
  const order = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
  const sorted = order.map((i) => starts[i]);
  const period = median(sorted.slice(1).map((t, i) => t - sorted[i]));
  if (period < PERIODIC_MIN_INTERVAL_MS) return result;
  // 구간마다 정렬된 자리 목록
  const runs: number[][] = [[0]];
  for (let i = 1; i < sorted.length; i++) {
    const run = runs[runs.length - 1];
    const gap = sorted[i] - sorted[run[run.length - 1]];
    if (Math.abs(gap - period) <= period * PERIODIC_TOLERANCE) run.push(i);
    else if (gap > period) runs.push([i]);
  }
  const periodic = runs.filter((run) => run.length >= 2);
  const covered = periodic.reduce((n, run) => n + run.length, 0);
  if (!periodic.some((run) => run.length >= PERIODIC_MIN_COUNT) || covered < sorted.length * PERIODIC_MIN_SHARE) return result;
  periodic.forEach((run) => run.forEach((i) => (result[order[i]] = true)));
  return result;
};

/** 같은 요청이 일정한 간격으로 3번 이상 반복됐는지 */
export const isPeriodic = (starts: readonly number[]): boolean => periodicStarts(starts).some(Boolean);

export const isAborted = (record: RequestRecord | undefined): boolean => !!record?.error && /abort/i.test(record.error);

/** 주기 판정은 같은 페이지 로드 안에서만 한다. 새로고침 앞뒤를 한 줄로 보면 그 사이 간격 때문에 주기가 깨진다. */
const periodicKeyOf = (r: RequestRecord): string => `${r.load ?? 0}|${requestKeyOf(r)}`;

/** 주기 반복에 든 요청의 id. 같은 요청끼리 모아 보되, 사이에 끼어든 요청은 빼고 반복에 든 요청만 담는다. */
const periodicRequestIds = (records: readonly RequestRecord[]): Set<number> => {
  const byKey = groupBy(
    records.filter((r) => !r.bodyUnreadable),
    periodicKeyOf,
  );
  const ids = new Set<number>();
  byKey.forEach((list) => {
    const periodic = periodicStarts(list.map((r) => r.startedAt));
    list.forEach((r, i) => periodic[i] && ids.add(r.id));
  });
  return ids;
};

// StrictMode 재실행은 effect → cleanup → effect 를 이어서 돌아 두 요청이 거의 함께 나간다. 이보다 벌어지면 cleanup 취소로 보지 않는다.
const STRICT_ABORT_GAP_MS = 200;

/**
 * 앞 요청이 취소된 중복이 StrictMode 재실행인가. 취소만으로는 확실하지 않다(React Query 는 마지막 관찰자가 빠지면 취소하고,
 * 겹친 무효화와 AbortController 를 쓰는 검색 입력도 앞 요청을 취소한다). 그래서 모두 맞을 때만 본다.
 * - 두 요청의 시작 간격이 매우 짧다.
 * - 겹친 무효화가 앞 요청을 취소한 것이 아니다(React Query 점검의 double-invalidate 와 같은 요청을 가리킨다).
 * - 두 요청 사이에 다시 마운트되거나 의존성이 바뀌지 않았다. 같은 commit 이면 그 사이 언마운트가 있을 수 없다(재실행은 한 commit 의 effect 다).
 *   commit 이 다르면(await 뒤에 보내 그 사이 다른 commit 이 낌) 유휴 큐가 정한 반복 이유가 재마운트·의존성 변경이 아닐 때만 본다.
 */
const abortedByStrictMode = (r: RequestRecord, prev: RequestRecord | undefined): boolean => {
  if (!prev || !isAborted(prev) || inFlightAtOverlap(prev)) return false;
  if (r.startedAt - prev.startedAt > STRICT_ABORT_GAP_MS) return false;
  const sameCommit = r.commitSeq === undefined || prev.commitSeq === undefined || r.commitSeq === prev.commitSeq;
  return sameCommit || (r.repeatCause?.kind !== 'remount' && r.repeatCause?.kind !== 'deps');
};

interface ClassifyContext {
  byId: ReadonlyMap<number, RequestRecord>;
  periodicIds: ReadonlySet<number>;
  ignoredEndpoints: ReadonlySet<string>;
}

/** 위에서부터 처음 맞는 규칙이 이긴다. 이유가 확실한 것부터 보고, 남은 것만 낭비로 둔다. */
const classifyOne = (r: RequestRecord, { byId, periodicIds, ignoredEndpoints }: ClassifyContext): RequestClass => {
  // 새로고침 전 기록과 같은 응답은 캐시가 비어 당연히 받은 요청이라 낭비가 아니다(다른 페이지 로드의 기록과 비교한 것).
  const sameAs = r.sameResponseAs === undefined ? undefined : byId.get(r.sameResponseAs);
  // restored 만으로는 가르지 않는다: 같은 이전 로드 안의 같은 응답 낭비까지 지워진다. 로드 번호가 다른 것만 경계다.
  const crossLoad = !!sameAs && (sameAs.load ?? 0) !== (r.load ?? 0);
  const flagged = !!(r.duplicateOf || (r.sameResponseAs && !crossLoad));
  if (!flagged) return 'ok';
  if (ignoredEndpoints.has(endpointOf(r))) return 'ignored';
  if (periodicIds.has(r.id)) return 'periodic';
  // StrictMode 는 dev 에서 effect 를 두 번 실행한다. 호출 스택에 React 의 재실행 함수가 있거나, 재실행의 정리(cleanup)가
  // 앞 요청을 취소했을 때만 확실하다고 본다(await 뒤에 보낸 요청은 스택에 남지 않아 취소가 유일한 근거다). 같은 위젯 두 개의 동시 요청은 낭비로 남는다.
  if (r.duplicateOf && (r.strictModeReplay || abortedByStrictMode(r, byId.get(r.duplicateOf)))) return 'strict-mode';
  // 포커스·재연결 직후에 같은 응답을 다시 받은 것은 라이브러리의 자동 재요청이다.
  // 같은 시점의 중복 요청(여러 컴포넌트가 함께 다시 부름)은 여전히 낭비다.
  if (!r.duplicateOf && r.trigger === 'focus') return 'focus-refetch';
  if (!r.duplicateOf && r.trigger === 'reconnect') return 'reconnect-refetch';
  if (r.duplicateOf) return 'duplicate';
  // React Query 의 재조회면 원인으로 나눈다. staleTime 0 의 반복은 빨강 그대로다(고칠 대상). 원인은 유휴 큐가 고정해 둔 값만 읽는다.
  const reason = pinnedRefetchReason(r);
  return reason === 'stale-elapsed' || reason === 'after-invalidate' ? reason : 'same-response';
};

/** 기록 전체를 한 번에 나눈다. 주기 판정은 같은 요청끼리 모아 봐야 해서 한 건씩은 할 수 없다. */
export const classifyRecords = (records: readonly RequestRecord[], ignoredEndpoints: ReadonlySet<string>): Map<number, RequestClass> => {
  const context: ClassifyContext = {
    byId: new Map(records.map((r) => [r.id, r])),
    periodicIds: periodicRequestIds(records),
    ignoredEndpoints,
  };
  return new Map(records.map((r) => [r.id, classifyOne(r, context)]));
};
