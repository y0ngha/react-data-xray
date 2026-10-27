import { useState } from 'react';

import { getTopRenders } from '../../core/render/monitor.js';
import { RENDER_STORM } from '../../core/render/types.js';
import { hasRecentBurst } from '../../core/requests/bursts.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { useInterval } from './useInterval.js';

const TICK_MS = 1000;

/** 지금 렌더 폭주(최근 10초에 RENDER_STORM 번 이상) 중인 컴포넌트 수. 렌더 감시가 꺼져 있으면 0 */
const countStorms = (now: number): number => getTopRenders(500, now).filter((e) => e.recent >= RENDER_STORM).length;

/**
 * RDX 버튼에 보여 줄 신호.
 * - issues: 낭비 요청이 있는 엔드포인트 수 + 렌더 폭주 중인 컴포넌트 수
 * - alert: 방금 요청이 몰렸거나 렌더 폭주가 새로 생겼다(1초 동안 켜진다)
 */
export const useProblemSignal = (records: readonly RequestRecord[], wasteEndpoints: number) => {
  const [signal, setSignal] = useState({ storms: 0, alert: false });
  useInterval(() => {
    const now = Date.now();
    const storms = countStorms(now);
    // useInterval 이 최신 콜백을 쓰므로 records 는 늘 지금 기록이다.
    const burst = hasRecentBurst(
      records.map((r) => r.startedAt),
      now,
    );
    setSignal((prev) => {
      const alert = burst || storms > prev.storms;
      return prev.storms === storms && prev.alert === alert ? prev : { storms, alert };
    });
  }, TICK_MS);
  return { issues: wasteEndpoints + signal.storms, alert: signal.alert };
};
