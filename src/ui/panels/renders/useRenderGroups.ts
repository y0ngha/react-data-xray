import { useEffect, useRef, useState } from 'react';

import type { Hit } from '../../../core/inspect/types.js';
import type { Fiber } from '../../../core/fiber/types.js';
import { isWithin } from '../../../core/fiber/tree.js';
import { sortRenderGroups, type RenderGroup, type RenderSort } from '../../../core/render/groups.js';
import { renderGroupsSteps, reportWindowMs } from '../../../core/render/monitor.js';
import { enqueue } from '../../../core/scheduler/idleQueue.js';

export interface ComputedGroups {
  items: GroupWithSource[];
  truncated: boolean;
  droppedInstances: number;
}

export interface GroupWithSource {
  group: RenderGroup;
  source: Hit | undefined;
}

/** 이 요소나 조상이 inline display:none 으로 숨었는지(요청 상세를 여는 동안 탭은 숨기기만 한다). */
const isHidden = (el: HTMLElement | null): boolean => {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) if (node.style.display === 'none') return true;
  return false;
};

/** 이 탭이 그리는 그룹 수. 출처 찾기는 이 안의 그룹에만 한다. */
export const MAX_GROUPS = 30;

/**
 * 렌더 요약·그룹·정렬·출처 찾기를 유휴 큐에서 조각으로 나눠 하고 결과만 state 로 돌려준다(렌더 중에 계산하지 않는다).
 * 보이는 MAX_GROUPS 개만 출처를 찾는다. 계산 중에는 1초 tick 이 와도 취소하지 않고 끝까지 돌리며(큐가 밀려도 결과가 나온다),
 * 계산이 끝난 뒤 다음 tick 에 다시 시작한다. 대상·정렬이 바뀌면 그때만 버리고 다시 한다.
 * 숨은 탭(요청 상세가 덮음)이나 숨은 페이지에서는 계산하지 않는다. 패널이 접히거나 탭을 바꾸면 컴포넌트가 사라져 멈춘다.
 */
export const useRenderGroups = (
  now: number,
  scope: Fiber | null,
  host: React.RefObject<HTMLElement | null>,
  sourceOf: (group: RenderGroup) => Hit | undefined,
  sort: RenderSort,
): ComputedGroups | null => {
  const [result, setResult] = useState<ComputedGroups | null>(null);
  const job = useRef<{ scope: Fiber | null; sort: RenderSort; cancelled: boolean; done: boolean } | null>(null);
  useEffect(() => {
    if (document.hidden || isHidden(host.current)) return;
    const cur = job.current;
    if (cur && !cur.done && !cur.cancelled && cur.scope === scope && cur.sort === sort) return;
    if (cur) cur.cancelled = true;
    const mine = { scope, sort, cancelled: false, done: false };
    job.current = mine;
    const windowMs = reportWindowMs(now);
    const steps = (function* (): Generator<void> {
      const { groups, truncated, droppedInstances } = yield* renderGroupsSteps(
        now,
        windowMs,
        (e) => !scope || isWithin(e.fiber as Fiber, scope),
      );
      const items: GroupWithSource[] = [];
      for (const group of sortRenderGroups(groups, sort).slice(0, MAX_GROUPS)) {
        items.push({ group, source: sourceOf(group) });
        yield;
      }
      if (!mine.cancelled) setResult({ items, truncated, droppedInstances });
    })();
    enqueue(() => {
      if (mine.cancelled) return true;
      let done = true; // 던지면 큐가 버리므로 끝난 것으로 둔다
      try {
        done = !!steps.next().done;
      } finally {
        mine.done = done;
      }
      return done;
    });
  }, [now, scope, host, sourceOf, sort]);
  useEffect(
    () => () => {
      if (job.current) job.current.cancelled = true;
    },
    [],
  );
  return result;
};
