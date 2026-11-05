import { collectValues } from '../fiber/componentValues.js';
import { componentRect, findRootFibers, getComponentName, hostNodesOf } from '../fiber/tree.js';
import { HOST_COMPONENT, isComposite, type Fiber } from '../fiber/types.js';
import { findDerivedOrigin, queueIndex } from './derivedMatch.js';
import { findExactOrigins } from './exactMatch.js';
import { flushQueue } from '../scheduler/idleQueue.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { RequestRecord } from '../requests/types.js';
import { childEntries, isOpaque } from '../../shared/objectWalk.js';
import type { Consumer, ConsumerMatch } from './types.js';

const MAX_CONSUMERS = 300;
const MAX_DEPTH = 3;
const MAX_CHILDREN = 100;
// 파생 매칭은 색인 조회라 비싸다. 요소 클릭(inspect)과 같이 컴포넌트 하나에서 후보는 30개까지만 본다.
const MAX_DERIVED_CANDIDATES = 30;

/** 값 안에 이 요청(같은 요청의 이전 응답 포함)의 응답 객체가 있는지 */
const holdsResponseOf = (root: unknown, requestKey: string, maxDepth = MAX_DEPTH): boolean => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) return requestKeyOf(origin.record) === requestKey;
    if (depth >= maxDepth || isOpaque(value)) return false;
    return childEntries(value, MAX_CHILDREN).some(([, child]) => walk(child, depth + 1));
  };
  return walk(root, 0);
};

/** fiber 하나가 이 요청의 데이터를 들고 있으면 그 자리(via) */
type Matcher = (fiber: Fiber) => string | undefined;

/** 같은 참조. 같은 객체(react-intl 의 IntlContext 값처럼 수천 컴포넌트가 함께 읽는 context 등)는 한 번만 훑는다. */
const exactMatcher = (key: string): Matcher => {
  const known = new Map<number, Map<object, boolean>>();
  const holds = (value: unknown, depth = MAX_DEPTH): boolean => {
    if (value === null || typeof value !== 'object') return false;
    const byDepth = known.get(depth) ?? new Map<object, boolean>();
    known.set(depth, byDepth);
    const cached = byDepth.get(value);
    if (cached !== undefined) return cached;
    const result = holdsResponseOf(value, key, depth);
    byDepth.set(value, result);
    return result;
  };
  return (fiber) => collectValues(fiber).find(({ value, searchDepth }) => holds(value, searchDepth))?.via;
};

/**
 * 파생: 참조는 다르지만 필드 값이 이 요청(같은 요청의 이전 응답 포함)의 응답 객체와 겹친다. 요소 클릭처럼 props·훅만 본다(context 는 보지 않는다).
 * 색인은 부르는 쪽이 먼저 마친다(queueIndex 뒤 큐 비우기, 또는 큐에서 색인 뒤로 미루기).
 */
const derivedMatcher = (key: string): Matcher => {
  const known = new WeakMap<object, boolean>();
  const matches = (value: object): boolean => {
    const cached = known.get(value);
    if (cached !== undefined) return cached;
    const origin = findDerivedOrigin(value);
    const result = !!origin && requestKeyOf(origin.record) === key;
    known.set(value, result);
    return result;
  };
  return (fiber) => {
    for (const { via, value, searchDepth } of collectValues(fiber)) {
      if (searchDepth !== undefined) continue;
      const { candidates } = findExactOrigins(value, via);
      const hit = candidates.slice(0, MAX_DERIVED_CANDIDATES).find((c) => matches(c.value));
      if (hit) return hit.where;
    }
    return undefined;
  };
};

/** rdx 자신이 그린 DOM 의 fiber. 그 아래(패널은 요청 기록을 props 로 들고 있다)는 내려가지 않는다. */
const isOwnHost = (fiber: Fiber, isOwnUi: (el: Element) => boolean): boolean =>
  fiber.tag === HOST_COMPONENT && fiber.stateNode instanceof Element && isOwnUi(fiber.stateNode);

/**
 * 트리를 깊이 우선으로 훑으며 이 요청의 데이터를 들고 있는 컴포넌트를 찾는다. fiber 하나마다 멈춰(yield) 부르는 쪽이 시간으로 끊을 수 있다.
 * 찾으면 그 소비자를, 못 찾으면 undefined 를 내놓는다. 유휴 큐에서 조각으로 돌 때(쓰지 않는 응답 판정)는 그 사이 commit 이 트리를 바꿀 수 있다.
 */
export function* scanConsumers(
  record: RequestRecord,
  isOwnUi: (el: Element) => boolean,
  match: ConsumerMatch,
): Generator<Consumer | undefined, void, void> {
  const key = requestKeyOf(record);
  const matcher = match === 'exact' ? exactMatcher(key) : derivedMatcher(key);
  // walkFibers 와 같은 순서(자기 → 자식 → 형제)를 멈췄다 이어 갈 수 있게 스택으로 돈다.
  const stack = findRootFibers()
    .map((root) => root.child)
    .filter((f): f is Fiber => !!f)
    .reverse();
  let id = 0;
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (isOwnHost(fiber, isOwnUi)) {
      yield undefined;
      continue;
    }
    if (fiber.child) stack.push(fiber.child);
    const via = isComposite(fiber) ? matcher(fiber) : undefined;
    yield via !== undefined && hostNodesOf(fiber).some((n) => !isOwnUi(n))
      ? { id: id++, name: getComponentName(fiber), rect: componentRect(fiber, isOwnUi), via, match }
      : undefined;
  }
}

const collect = (scan: Generator<Consumer | undefined, void, void>): Consumer[] => {
  const consumers: Consumer[] = [];
  for (const found of scan) {
    if (found) consumers.push(found);
    if (consumers.length >= MAX_CONSUMERS) break;
  }
  return consumers;
};

/**
 * 같은 요청(메서드·URL·payload)의 응답 객체를 props·훅 state 로 들고 있는 컴포넌트.
 * React Query 는 응답이 같으면 이전 객체를 재사용하므로, 이 요청 하나가 아니라 같은 요청의 이전 응답까지 함께 본다.
 * derived 면 참조로 하나도 못 찾았을 때 파생(필드 값 겹침)으로 한 번 더 찾는다. 쓰지 않는 응답 판정(unused.ts)과 같은 기준이다.
 */
export const findConsumers = (
  record: RequestRecord,
  isOwnUi: (el: Element) => boolean,
  /** 방금 도착한 큰 응답의 출처 등록을 마치려고 큐를 비우는 시간 상한. 렌더 중에는 부르지 않는다(큐의 step 이 setState 할 수 있다). */
  flushLimitMs = 1000,
  { derived = false }: { derived?: boolean } = {},
): Consumer[] => {
  queueIndex();
  flushQueue(flushLimitMs);
  const exact = collect(scanConsumers(record, isOwnUi, 'exact'));
  return exact.length > 0 || !derived ? exact : collect(scanConsumers(record, isOwnUi, 'derived'));
};
