import { childEntries, isOpaque } from '../../shared/objectWalk.js';
import { getOrigin } from '../requests/origins.js';
import type { RequestRecord } from '../requests/types.js';
import type { ReasonResult } from './renderReason.js';
import type { NetworkCause } from './types.js';

// 응답이 도착하고 이 시간 안에 렌더됐을 때만 그 응답 때문이라고 본다.
// 예전 응답 데이터를 담은 채 다른 이유로 state 를 바꾼 경우(setState({...prev, filter}))를 걸러 낸다.
const NETWORK_CAUSE_WINDOW_MS = 3000;
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

/**
 * 네트워크 원인: 자기 변경값에 최근 응답이 있으면 direct, 없으면 네트워크 때문에 렌더된 조상을 이어받는다.
 * 자기 state 가 바뀐 렌더는 조상을 이어받지 않는다(그 state 변경이 이 렌더의 원인이다).
 */
export const causeOf = (result: ReasonResult, inherited: NetworkCause | undefined, now: number): NetworkCause | undefined => {
  const record = findRecentResponse(result.changed, now);
  if (record) return { record, via: 'direct' };
  if (result.reason === 'state' || !inherited) return undefined;
  return { record: inherited.record, via: 'parent' };
};
