import { useEffect, useState } from 'react';

import type { Hit } from '../../../core/inspect/types.js';
import type { Fiber } from '../../../core/fiber/types.js';
import { isWithin } from '../../../core/fiber/tree.js';
import { groupRenders, type RenderGroup } from '../../../core/render/groups.js';
import { getTopRenders } from '../../../core/render/monitor.js';
import { WINDOW_MS } from '../../../core/render/summary.js';
import { enqueue } from '../../../core/scheduler/idleQueue.js';

const MAX_RENDERS = 500;

export interface GroupWithSource {
  group: RenderGroup;
  source: Hit | undefined;
}

/** 이 요소나 조상이 inline display:none 으로 숨었는지(요청 상세를 여는 동안 탭은 숨기기만 한다). */
const isHidden = (el: HTMLElement | null): boolean => {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) if (node.style.display === 'none') return true;
  return false;
};

/**
 * 렌더 요약·그룹·출처 찾기를 유휴 큐에서 하고 결과만 state 로 돌려준다(렌더 중에 계산하지 않는다).
 * 숨은 탭(요청 상세가 덮음)이나 숨은 페이지에서는 계산하지 않는다. 패널이 접히거나 탭을 바꾸면 컴포넌트가 사라져 멈춘다.
 */
export const useRenderGroups = (
  now: number,
  scope: Fiber | null,
  host: React.RefObject<HTMLElement | null>,
  sourceOf: (group: RenderGroup) => Hit | undefined,
): GroupWithSource[] | null => {
  const [result, setResult] = useState<GroupWithSource[] | null>(null);
  useEffect(() => {
    if (document.hidden || isHidden(host.current)) return undefined;
    let cancelled = false;
    enqueue(() => {
      if (cancelled) return true;
      const renders = getTopRenders(MAX_RENDERS, now, (e) => !scope || isWithin(e.fiber as Fiber, scope));
      const groups = groupRenders(renders, now - WINDOW_MS);
      setResult(groups.map((group) => ({ group, source: sourceOf(group) })));
      return true;
    });
    return () => {
      cancelled = true;
    };
  }, [now, scope, host, sourceOf]);
  return result;
};
