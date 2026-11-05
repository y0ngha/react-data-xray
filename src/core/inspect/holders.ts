import { collectValues } from '../fiber/componentValues.js';
import type { Fiber } from '../fiber/types.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { RequestRecord } from '../requests/types.js';
import { childEntries, isOpaque } from '../../shared/objectWalk.js';
import { findDerivedOrigins } from './derivedMatch.js';
import type { ConsumerMatch } from './types.js';

const MAX_DEPTH = 3;
const MAX_CHILDREN = 100;
// 파생 매칭은 색인 조회라 비싸다. 요소 클릭(inspect)과 같이 값 하나에서 후보는 30개까지만 본다.
const MAX_DERIVED_CANDIDATES = 30;
// 값 안의 객체를 이만큼 볼 때마다 멈춘다(yield). 큰 목록을 든 fiber 하나가 큐 조각을 넘지 않게 한다.
const NODES_PER_YIELD = 32;

const keys = new WeakMap<RequestRecord, string>();

/** 같은 요청(메서드·URL·payload) 키. 출처마다 URL 을 다시 파싱하지 않게 기록마다 기억한다. */
export const keyOfRecord = (record: RequestRecord): string => {
  let key = keys.get(record);
  if (key === undefined) {
    key = requestKeyOf(record);
    keys.set(record, key);
  }
  return key;
};

/** fiber 가 들고 있는 찾는 요청의 키와, 컴포넌트 안에서 그 데이터가 있던 곳 */
export interface Held {
  key: string;
  via: string;
}

export type FiberHolds = (fiber: Fiber, wanted: ReadonlySet<string>) => Generator<void, Held[], void>;

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

/**
 * 찾는 요청(같은 요청의 이전 응답 포함)의 응답 객체를 fiber 가 들고 있는지 보는 함수를 만든다. 트리를 한 번 훑는 동안 쓰고 버린다.
 * - exact: 값 안(깊이 3, context 는 1)에서 출처가 등록된 객체를 찾는다. 다른 요청의 객체가 아무리 많아도 멈추지 않는다(찾는 수 상한이 없다).
 * - derived: 출처가 없는 객체(값 하나에서 30개까지)의 필드 값이 응답 객체와 겹치면, 기준을 넘는 출처 모두를 본다(가장 잘 맞는 하나만이 아니다).
 *   요소 클릭처럼 props·훅만 본다(context 는 보지 않는다). 색인은 부르는 쪽이 먼저 마친다.
 * 같은 객체(수천 컴포넌트가 함께 읽는 context 값 등)는 한 번만 훑는다. 객체 32개마다, 파생 후보마다 멈춘다.
 */
export const createFiberHolds = (match: ConsumerMatch): FiberHolds => {
  const exactCache = new Map<number, WeakMap<object, readonly string[]>>();
  const derivedCache = new WeakMap<object, readonly string[]>();
  let visited = 0;
  const due = (): boolean => ++visited % NODES_PER_YIELD === 0;

  function* exactKeys(root: object, maxDepth: number): Generator<void, readonly string[], void> {
    const byDepth = exactCache.get(maxDepth) ?? new WeakMap<object, readonly string[]>();
    exactCache.set(maxDepth, byDepth);
    const cached = byDepth.get(root);
    if (cached) return cached;
    const found = new Set<string>();
    const seen = new WeakSet<object>();
    const stack: Array<[object, number]> = [[root, 0]];
    while (stack.length > 0) {
      const [value, depth] = stack.pop()!;
      if (seen.has(value)) continue;
      seen.add(value);
      if (due()) yield;
      const origin = getOrigin(value);
      if (origin) {
        found.add(keyOfRecord(origin.record));
        continue;
      }
      if (depth >= maxDepth || isOpaque(value)) continue;
      for (const [, child] of childEntries(value, MAX_CHILDREN)) if (isObject(child)) stack.push([child, depth + 1]);
    }
    const result = [...found];
    byDepth.set(root, result);
    return result;
  }

  const derivedOf = (value: object): readonly string[] => {
    let result = derivedCache.get(value);
    if (!result) {
      result = [...new Set(findDerivedOrigins(value).map((o) => keyOfRecord(o.record)))];
      derivedCache.set(value, result);
    }
    return result;
  };

  function* derivedKeys(root: object): Generator<void, readonly string[], void> {
    const found = new Set<string>();
    const seen = new WeakSet<object>();
    const stack: Array<[object, number]> = [[root, 0]];
    let candidates = 0;
    while (stack.length > 0 && candidates < MAX_DERIVED_CANDIDATES) {
      const [value, depth] = stack.pop()!;
      if (seen.has(value) || getOrigin(value) || isOpaque(value)) continue;
      seen.add(value);
      if (!Array.isArray(value)) {
        candidates++;
        yield; // 후보 하나가 색인 조회 한 번이다
        derivedOf(value).forEach((key) => found.add(key));
      }
      if (depth < MAX_DEPTH) for (const [, child] of childEntries(value, MAX_CHILDREN)) if (isObject(child)) stack.push([child, depth + 1]);
    }
    return [...found];
  }

  return function* fiberHolds(fiber, wanted) {
    const held: Held[] = [];
    for (const { via, value, searchDepth } of collectValues(fiber)) {
      if (!isObject(value) || (match === 'derived' && searchDepth !== undefined)) continue;
      const found = match === 'exact' ? yield* exactKeys(value, searchDepth ?? MAX_DEPTH) : yield* derivedKeys(value);
      for (const key of found) if (wanted.has(key) && !held.some((h) => h.key === key)) held.push({ key, via });
    }
    return held;
  };
};

/** 멈추는 일(generator)을 그 자리에서 끝까지 돌린다(사용자 조회용). */
export const drain = <T>(work: Generator<void, T, void>): T => {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
};
