import { collectValues } from '../fiber/componentValues.js';
import { componentRect, findRootFibers, getComponentName, hostNodesOf, walkFibers } from '../fiber/tree.js';
import { isComposite } from '../fiber/types.js';
import { flushIndex } from './derivedMatch.js';
import { flushQueue } from '../scheduler/idleQueue.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { RequestRecord } from '../requests/types.js';
import { childEntries, isOpaque } from '../../shared/objectWalk.js';
import type { Consumer } from './types.js';

const MAX_CONSUMERS = 300;
const MAX_DEPTH = 3;
const MAX_CHILDREN = 100;

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

/**
 * 같은 요청(메서드·URL·payload)의 응답 객체를 props·훅 state 로 들고 있는 컴포넌트.
 * React Query 는 응답이 같으면 이전 객체를 재사용하므로, 이 요청 하나가 아니라 같은 요청의 이전 응답까지 함께 본다.
 */
export const findConsumers = (record: RequestRecord, isOwnUi: (el: Element) => boolean): Consumer[] => {
  flushIndex(); // 방금 도착한 큰 응답의 출처 등록이 남아 있지 않게
  flushQueue(1000);
  const key = requestKeyOf(record);
  const consumers: Consumer[] = [];
  // 같은 객체(react-intl 의 IntlContext 값처럼 수천 컴포넌트가 함께 읽는 context 등)는 한 번만 훑는다.
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
  findRootFibers().forEach((root) =>
    walkFibers(root.child, (f) => {
      if (consumers.length >= MAX_CONSUMERS) return false;
      const found = isComposite(f) ? collectValues(f).find(({ value, searchDepth }) => holds(value, searchDepth)) : undefined;
      if (found && hostNodesOf(f).some((n) => !isOwnUi(n)))
        consumers.push({ id: consumers.length, name: getComponentName(f), rect: componentRect(f, isOwnUi), via: found.via });
      return true;
    }),
  );
  return consumers;
};
