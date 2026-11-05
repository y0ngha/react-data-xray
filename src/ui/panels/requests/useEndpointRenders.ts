import { useEffect, useRef, useState } from 'react';

import type { Fiber } from '../../../core/fiber/types.js';
import { isWithin } from '../../../core/fiber/tree.js';
import type { EndpointRenders } from '../../../core/render/endpointRenders.js';
import { endpointRendersSteps, reportWindowMs } from '../../../core/render/monitor.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { enqueue } from '../../../core/scheduler/idleQueue.js';

/** 이 요소나 조상이 inline display:none 으로 숨었는지(요청 상세를 여는 동안 탭은 숨기기만 한다). */
const isHidden = (el: HTMLElement | null): boolean => {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) if (node.style.display === 'none') return true;
  return false;
};

/**
 * 엔드포인트별 렌더 비용(#84)을 유휴 큐에서 조각으로 세고 결과만 state 로 돌려준다(렌더 중에 계산하지 않는다).
 * records 는 지금 보이는 요청이다(경로 필터 중이면 그 경로의 것). 그 요청이 원인인 렌더만 센다.
 * 구간은 렌더 탭·보고서와 같다. 계산 중에 tick 이 와도 끝까지 돌리고, 끝난 뒤 다음 tick 에 다시 센다.
 * 대상이나 필터(filterKey)가 바뀌면 버리고 다시 한다. 숨은 탭(요청 상세가 덮음)이나 숨은 페이지에서는 세지 않는다.
 * 렌더 감시는 RDX 버튼(useProblemSignal)이 붙어 있는 동안 켜 두므로 여기서 켜지 않는다.
 */
export const useEndpointRenders = (
  now: number,
  scope: Fiber | null,
  records: readonly RequestRecord[],
  filterKey: string | undefined,
  host: React.RefObject<HTMLElement | null>,
): ReadonlyMap<string, EndpointRenders> | null => {
  const [result, setResult] = useState<ReadonlyMap<string, EndpointRenders> | null>(null);
  const job = useRef<{ scope: Fiber | null; filterKey: string | undefined; cancelled: boolean; done: boolean } | null>(null);
  useEffect(() => {
    if (document.hidden || isHidden(host.current)) return;
    const cur = job.current;
    if (cur && !cur.done && !cur.cancelled && cur.scope === scope && cur.filterKey === filterKey) return;
    if (cur) cur.cancelled = true;
    const mine = { scope, filterKey, cancelled: false, done: false };
    job.current = mine;
    const shown = new Set(records);
    const steps = endpointRendersSteps(now, reportWindowMs(now), {
      keep: (e) => !scope || isWithin(e.fiber as Fiber, scope),
      include: (r) => shown.has(r),
    });
    enqueue(() => {
      if (mine.cancelled) return true;
      let done = true; // 던지면 큐가 버리므로 끝난 것으로 둔다
      try {
        const r = steps.next();
        done = !!r.done;
        if (r.done && !mine.cancelled) setResult(r.value);
      } finally {
        mine.done = done;
      }
      return done;
    }, 'ui'); // 패널만 쓰는 목록이다. 보고서는 buildReport 가 그 자리에서 센다
  }, [now, scope, records, filterKey, host]);
  useEffect(
    () => () => {
      if (job.current) job.current.cancelled = true;
    },
    [],
  );
  return result;
};
