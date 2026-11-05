import { useEffect, useRef, useState } from 'react';

import type { Fiber } from '../../../core/fiber/types.js';
import { isWithin } from '../../../core/fiber/tree.js';
import type { EndpointRenders } from '../../../core/render/endpointRenders.js';
import { endpointRendersSteps, reportWindowMs } from '../../../core/render/monitor.js';
import { enqueue } from '../../../core/scheduler/idleQueue.js';

/**
 * 엔드포인트별 렌더 비용(#84)을 유휴 큐에서 조각으로 세고 결과만 state 로 돌려준다(렌더 중에 계산하지 않는다).
 * 구간은 렌더 탭·보고서와 같다. 계산 중에 tick 이 와도 끝까지 돌리고, 끝난 뒤 다음 tick 에 다시 센다. 대상이 바뀌면 버리고 다시 한다.
 * 숨은 페이지에서는 세지 않는다.
 */
export const useEndpointRenders = (now: number, scope: Fiber | null): ReadonlyMap<string, EndpointRenders> | null => {
  const [result, setResult] = useState<ReadonlyMap<string, EndpointRenders> | null>(null);
  const job = useRef<{ scope: Fiber | null; cancelled: boolean; done: boolean } | null>(null);
  useEffect(() => {
    if (document.hidden) return;
    const cur = job.current;
    if (cur && !cur.done && !cur.cancelled && cur.scope === scope) return;
    if (cur) cur.cancelled = true;
    const mine = { scope, cancelled: false, done: false };
    job.current = mine;
    const steps = endpointRendersSteps(now, reportWindowMs(now), (e) => !scope || isWithin(e.fiber as Fiber, scope));
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
    });
  }, [now, scope]);
  useEffect(
    () => () => {
      if (job.current) job.current.cancelled = true;
    },
    [],
  );
  return result;
};
