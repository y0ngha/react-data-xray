import type { Fiber } from '../fiber/types.js';

// 요청 원인 판정(requests)이 렌더 감시(monitor)를 가져오면 import 가 순환하므로, 판정에 쓰는 시각만 여기 둔다.
// monitor 가 유휴 큐에서 렌더를 기록할 때 같이 적는다.

const MAX_COMMITS = 500;
// WeakMap 은 비울 수 없어, reset 때 세대를 올려 그 전 기록을 버린다.
let generation = 0;
const renderedAt = new WeakMap<Fiber, { time: number; generation: number }>();
const commitTimes: number[] = [];

export const noteRender = (fiber: Fiber, alt: Fiber | null, time: number): void => {
  const at = { time, generation };
  renderedAt.set(fiber, at);
  if (alt) renderedAt.set(alt, at);
};

export const noteCommit = (time: number): void => {
  commitTimes.push(time);
  if (commitTimes.length > MAX_COMMITS) commitTimes.shift();
};

/** 이 fiber 가 마지막으로 렌더된 commit 시각. 감시가 꺼져 있었거나 reset 뒤 렌더가 없으면 undefined */
export const lastRenderAt = (fiber: Fiber): number | undefined => {
  const at = renderedAt.get(fiber) ?? (fiber.alternate ? renderedAt.get(fiber.alternate) : undefined);
  return at?.generation === generation ? at.time : undefined;
};

/** at 이전(포함) 마지막 commit 시각. 기록이 없으면 undefined */
export const lastCommitBefore = (at: number): number | undefined => {
  for (let i = commitTimes.length - 1; i >= 0; i--) if (commitTimes[i] <= at) return commitTimes[i];
  return undefined;
};

export const resetRenderTimes = (): void => {
  commitTimes.length = 0;
  generation++;
};
