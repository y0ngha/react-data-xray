import { findRootFibers, getComponentName, hostNodesOf, unionRect, walkFibers } from '../fiber/tree.js';
import { isComposite } from '../fiber/types.js';
import { queueIndex } from './derivedMatch.js';
import { createFiberHolds, drain, keyOfRecord } from './holders.js';
import { flushQueue } from '../scheduler/idleQueue.js';
import type { RequestRecord } from '../requests/types.js';
import type { Consumer, ConsumerMatch } from './types.js';

const MAX_CONSUMERS = 300;

/**
 * 같은 요청(메서드·URL·payload)의 응답 객체를 props·훅 state 로 들고 있는 컴포넌트.
 * React Query 는 응답이 같으면 이전 객체를 재사용하므로, 이 요청 하나가 아니라 같은 요청의 이전 응답까지 함께 본다.
 * derived 면 참조로 하나도 못 찾았을 때 파생(필드 값 겹침)으로 한 번 더 찾는다. 쓰지 않는 응답 판정(unused.ts)과 같은 기준이다.
 */
export const findConsumers = (
  record: RequestRecord,
  isOwnUi: (el: Element) => boolean,
  /**
   * 방금 도착한 큰 응답의 출처 등록을 마치려고 큐를 비우는 시간 상한. 렌더 중에는 부르지 않는다(큐의 step 이 setState 할 수 있다).
   * 0 이면 비우지 않는다(열린 상세가 기록이 바뀔 때 다시 찾을 때: 그때까지 등록된 출처로만 찾는다).
   */
  flushLimitMs = 1000,
  { derived = false }: { derived?: boolean } = {},
): Consumer[] => {
  queueIndex();
  if (flushLimitMs > 0) flushQueue(flushLimitMs);
  const wanted = new Set([keyOfRecord(record)]);
  const collect = (match: ConsumerMatch): Consumer[] => {
    const holds = createFiberHolds(match);
    const consumers: Consumer[] = [];
    findRootFibers().forEach((root) =>
      walkFibers(root.child, (f) => {
        if (consumers.length >= MAX_CONSUMERS) return false;
        const [found] = isComposite(f) ? drain(holds(f, wanted)) : [];
        if (!found) return true;
        const nodes = hostNodesOf(f).filter((n) => !isOwnUi(n));
        if (nodes.length > 0)
          consumers.push({ id: consumers.length, name: getComponentName(f), rect: unionRect(nodes), via: found.via, nodes, match });
        return true;
      }),
    );
    return consumers;
  };
  const exact = collect('exact');
  return exact.length > 0 || !derived ? exact : collect('derived');
};
