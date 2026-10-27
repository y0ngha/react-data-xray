import { collectValues } from '../fiber/componentValues.js';
import { componentRect, findRootFibers, getComponentName, hostNodesOf, walkFibers } from '../fiber/tree.js';
import { isComposite } from '../fiber/types.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { RequestRecord } from '../requests/types.js';
import { childEntries, isOpaque } from '../../shared/objectWalk.js';
import type { Consumer } from './types.js';

const MAX_CONSUMERS = 300;
const MAX_DEPTH = 3;
const MAX_CHILDREN = 100;

/** 값 안에 이 요청(같은 요청의 이전 응답 포함)의 응답 객체가 있는지 */
const holdsResponseOf = (root: unknown, requestKey: string): boolean => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) return requestKeyOf(origin.record) === requestKey;
    if (depth >= MAX_DEPTH || isOpaque(value)) return false;
    return childEntries(value, MAX_CHILDREN).some(([, child]) => walk(child, depth + 1));
  };
  return walk(root, 0);
};

/**
 * 같은 요청(메서드·URL·payload)의 응답 객체를 props·훅 state 로 들고 있는 컴포넌트.
 * React Query 는 응답이 같으면 이전 객체를 재사용하므로, 이 요청 하나가 아니라 같은 요청의 이전 응답까지 함께 본다.
 */
export const findConsumers = (record: RequestRecord, isOwnUi: (el: Element) => boolean): Consumer[] => {
  const key = requestKeyOf(record);
  const consumers: Consumer[] = [];
  findRootFibers().forEach((root) =>
    walkFibers(root.child, (f) => {
      if (consumers.length >= MAX_CONSUMERS) return false;
      const found = isComposite(f) ? collectValues(f).find(({ value }) => holdsResponseOf(value, key)) : undefined;
      if (found && hostNodesOf(f).some((n) => !isOwnUi(n)))
        consumers.push({ id: consumers.length, name: getComponentName(f), rect: componentRect(f, isOwnUi), via: found.via });
      return true;
    }),
  );
  return consumers;
};
