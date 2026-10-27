import { endpointOf, requestKeyOf, type RequestRecord } from './registry.js';

/**
 * 요청 하나를 세 단계로 나눈다.
 * - 낭비(빨강): duplicate, same-response
 * - 확인 필요(노랑): periodic, focus-refetch. 의도된 동작일 가능성이 높지만, 바뀌지 않는 데이터를
 *   너무 자주 받거나 캐시 설정(staleTime)이 짧다는 신호일 수 있어 숨기지 않는다.
 * - 정상(회색): strict-mode(호출 스택으로 확인한 것만), reconnect-refetch, ignored(사용자가 지정)
 */
export type RequestClass =
  | 'duplicate'
  | 'same-response'
  | 'periodic'
  | 'strict-mode'
  | 'focus-refetch'
  | 'reconnect-refetch'
  | 'ignored'
  | 'ok';

export const CLASS_LABEL: Record<RequestClass, string> = {
  duplicate: '중복 요청',
  'same-response': '같은 응답 재요청',
  periodic: '주기 요청',
  'strict-mode': 'StrictMode 가능성',
  'focus-refetch': '포커스 재요청',
  'reconnect-refetch': '재연결 재요청',
  ignored: '무시함',
  ok: '',
};

export const isWaste = (c: RequestClass | undefined): boolean => c === 'duplicate' || c === 'same-response';
export const needsReview = (c: RequestClass | undefined): boolean => c === 'periodic' || c === 'focus-refetch';

const PERIODIC_MIN_COUNT = 3;
const PERIODIC_MIN_INTERVAL_MS = 1000;
// 간격이 중앙값에서 이만큼 안쪽이면 일정한 주기로 본다.
const PERIODIC_TOLERANCE = 0.25;

/** 같은 요청이 일정한 간격으로 3번 이상 반복됐는지. 대시보드 polling 같은 의도된 반복이다. */
export const isPeriodic = (starts: number[]): boolean => {
  if (starts.length < PERIODIC_MIN_COUNT) return false;
  const sorted = [...starts].sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((t, i) => t - sorted[i]);
  const median = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  if (median < PERIODIC_MIN_INTERVAL_MS) return false;
  return intervals.every((d) => Math.abs(d - median) <= median * PERIODIC_TOLERANCE);
};

const isAborted = (record: RequestRecord | undefined) => !!record?.error && /abort/i.test(record.error);

/** 기록 전체를 한 번에 나눈다. 주기 판정은 같은 요청끼리 모아 봐야 해서 한 건씩은 할 수 없다. */
export const classifyRecords = (records: readonly RequestRecord[], ignoredEndpoints: ReadonlySet<string>): Map<number, RequestClass> => {
  const byId = new Map(records.map((r) => [r.id, r]));
  const byKey = new Map<string, RequestRecord[]>();
  for (const r of records) {
    if (r.bodyUnreadable) continue;
    const key = requestKeyOf(r);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const periodicKeys = new Set(
    Array.from(byKey)
      .filter(([, list]) => isPeriodic(list.map((r) => r.startedAt)))
      .map(([key]) => key),
  );

  const result = new Map<number, RequestClass>();
  for (const r of records) {
    const flagged = !!(r.duplicateOf || r.sameResponseAs);
    let c: RequestClass = 'ok';
    if (flagged && ignoredEndpoints.has(endpointOf(r))) c = 'ignored';
    else if (flagged && !r.bodyUnreadable && periodicKeys.has(requestKeyOf(r))) c = 'periodic';
    // StrictMode 는 dev 에서 effect 를 두 번 실행한다. 정리(cleanup)에서 앞 요청을 취소했거나,
    // 호출 스택에 React 의 재실행 함수가 있을 때만 확실하다고 본다. 같은 위젯 두 개의 동시 요청은 낭비로 남는다.
    else if (r.duplicateOf && (isAborted(byId.get(r.duplicateOf)) || r.strictModeReplay)) c = 'strict-mode';
    // 포커스·재연결 직후에 같은 응답을 다시 받은 것은 라이브러리의 자동 재요청이다.
    // 같은 시점의 중복 요청(여러 컴포넌트가 함께 다시 부름)은 여전히 낭비다.
    else if (!r.duplicateOf && r.sameResponseAs && r.trigger === 'focus') c = 'focus-refetch';
    else if (!r.duplicateOf && r.sameResponseAs && r.trigger === 'reconnect') c = 'reconnect-refetch';
    else if (r.duplicateOf) c = 'duplicate';
    else if (r.sameResponseAs) c = 'same-response';
    result.set(r.id, c);
  }
  return result;
};

// 페이지에 들어온 직후에는 화면 전체가 동시에 데이터를 불러오는 것이 정상이다.
export const INITIAL_LOAD_MS = 3000;

/** 페이지 진입(navigation 시작) 후 3초 안인지 */
export const isInitialLoad = (time: number): boolean =>
  typeof performance !== 'undefined' && time - performance.timeOrigin < INITIAL_LOAD_MS;
