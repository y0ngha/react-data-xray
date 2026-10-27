import { useState } from 'react';

import { getTopRenders } from '../../core/render/monitor.js';
import { RENDER_STORM } from '../../core/render/types.js';
import { findBursts, isInitialLoad } from '../../core/requests/bursts.js';
import type { RequestClass } from '../../core/requests/classify.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { useInterval } from './useInterval.js';
import { useRenderMonitoring } from './useRenderMonitoring.js';

const TICK_MS = 1000;
// 버튼을 깜빡이게 할 "방금" 의 범위
const RECENT_MS = 2000;

/** 지금 렌더 폭주(최근 10초에 RENDER_STORM 번 이상) 중인 컴포넌트 이름 */
const stormingNames = (now: number): Set<string> =>
  new Set(
    getTopRenders(500, now)
      .filter((e) => e.recent >= RENDER_STORM)
      .map((e) => e.name),
  );

/** 방금 끝난 요청 몰림의 끝 시각. 페이지 첫 로딩 몰림과, 이유가 확실한 반복(무시·StrictMode)은 뺀다. */
const latestBurstEnd = (records: readonly RequestRecord[], classOf: (r: RequestRecord) => RequestClass, now: number): number => {
  const starts = records
    .filter((r) => now - r.startedAt <= RECENT_MS && !isInitialLoad(r.startedAt))
    .filter((r) => classOf(r) !== 'ignored' && classOf(r) !== 'strict-mode')
    .map((r) => r.startedAt);
  return Math.max(0, ...findBursts(starts).map((b) => b.to));
};

interface Signal {
  storming: ReadonlySet<string>;
  lastBurst: number;
  alert: boolean;
}

/**
 * RDX 버튼에 보여 줄 신호. 버튼은 패널을 닫아 둔 동안에도 알려야 하므로, 붙어 있는 동안 렌더 감시를 켠다.
 * - issues: 낭비 요청이 있는 엔드포인트 수 + 렌더 폭주 중인 컴포넌트 수
 * - alert: 새 요청 몰림이 생겼거나 새 컴포넌트가 렌더 폭주에 들어왔다(그 1초 동안만 켜진다)
 */
export const useProblemSignal = (
  records: readonly RequestRecord[],
  classOf: (r: RequestRecord) => RequestClass,
  wasteEndpoints: number,
) => {
  useRenderMonitoring();
  const [signal, setSignal] = useState<Signal>({ storming: new Set(), lastBurst: 0, alert: false });
  useInterval(() => {
    const now = Date.now();
    const storming = stormingNames(now);
    // useInterval 이 최신 콜백을 쓰므로 records 는 늘 지금 기록이다.
    const burstEnd = latestBurstEnd(records, classOf, now);
    setSignal((prev) => {
      const newStorm = [...storming].some((name) => !prev.storming.has(name));
      const newBurst = burstEnd > prev.lastBurst;
      return { storming, lastBurst: Math.max(prev.lastBurst, burstEnd), alert: newStorm || newBurst };
    });
  }, TICK_MS);
  return { issues: wasteEndpoints + signal.storming.size, alert: signal.alert };
};
