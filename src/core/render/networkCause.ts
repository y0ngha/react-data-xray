import { childEntries, isOpaque } from '../../shared/objectWalk.js';
import { getOrigin } from '../requests/origins.js';
import { getRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import type { ReasonResult } from './renderReason.js';
import type { NetworkCause } from './types.js';

// 응답이 도착하고 이 시간 안에 렌더됐을 때만 그 응답 때문이라고 본다.
// 예전 응답 데이터를 담은 채 다른 이유로 state 를 바꾼 경우(setState({...prev, filter}))를 걸러 낸다.
const NETWORK_CAUSE_WINDOW_MS = 3000;
// 응답 객체를 못 찾았을 때, 응답이 도착하고 이만큼 안에 자기 state 가 바뀌었으면 그 응답 직후의 렌더로 본다.
// fetch → json() → setState → commit 은 보통 수 ms 안에 끝난다. 길게 잡으면 상관없는 입력 렌더까지 붙는다.
const TIMING_WINDOW_MS = 100;
// 최근 기록 몇 개만 본다(state 렌더마다 부르므로).
const RECENT_RECORDS = 20;
const MAX_DEPTH = 3;
const MAX_CHILDREN = 50;

const arrivedRecently = (record: RequestRecord, now: number): boolean => {
  const arrived = record.startedAt + record.durationMs;
  return now >= arrived && now - arrived <= NETWORK_CAUSE_WINDOW_MS;
};

/** 값 안에서 최근에 도착한 응답의 객체를 찾는다. */
export const findRecentResponse = (values: readonly unknown[], now: number): RequestRecord | undefined => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): RequestRecord | undefined => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) return arrivedRecently(origin.record, now) ? origin.record : undefined;
    if (depth >= MAX_DEPTH || isOpaque(value)) return undefined;
    return childEntries(value, MAX_CHILDREN).reduce<RequestRecord | undefined>(
      (found, [, child]) => found ?? walk(child, depth + 1),
      undefined,
    );
  };
  return values.reduce<RequestRecord | undefined>((found, v) => found ?? walk(v, 0), undefined);
};

/** 방금(TIMING_WINDOW_MS 안) 도착한 응답 중 가장 최근 것 */
export const justArrived = (now: number): RequestRecord | undefined => {
  const records = getRecords();
  // 분석이 나중에 돌아 now 이후에 도착한 기록이 있을 수 있다. 그것들은 창을 쓰지 않게 건너뛴다.
  let scanned = 0;
  for (let i = records.length - 1; i >= 0 && scanned < RECENT_RECORDS; i--) {
    const arrived = records[i].startedAt + records[i].durationMs;
    if (arrived > now) continue;
    scanned++;
    if (now - arrived <= TIMING_WINDOW_MS) return records[i];
  }
  return undefined;
};

/**
 * 네트워크 원인: 자기 변경값에 최근 응답이 있으면 direct, 없으면 네트워크 때문에 렌더된 조상을 이어받는다.
 * 자기 state 가 바뀐 렌더는 조상을 이어받지 않는다(그 state 변경이 이 렌더의 원인이다).
 * 다만 응답을 가공해(map, 빈 배열) 넣으면 객체로는 이어지지 않으므로, 응답 직후의 state 변경은 timing 으로 남긴다.
 * 그래야 "응답 → state → effect → 다시 요청" 고리를 "네트워크와 무관"이라고 잘못 말하지 않는다.
 */
export const causeOf = (result: ReasonResult, inherited: NetworkCause | undefined, now: number): NetworkCause | undefined => {
  const record = findRecentResponse(result.changed, now);
  if (record) return { record, via: 'direct' };
  if (result.reason === 'state') {
    const arrived = justArrived(now);
    return arrived ? { record: arrived, via: 'timing' } : undefined;
  }
  if (!inherited) return undefined;
  return { record: inherited.record, via: 'parent' };
};
