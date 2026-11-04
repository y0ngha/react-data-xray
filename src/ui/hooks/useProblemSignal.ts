import { useRef, useState } from 'react';

import { findQueryClients } from '../../core/reactQuery/cacheAudit.js';
import { countProblems, findRenderStorms, type RenderStorm, type WasteRow } from '../../core/problems.js';
import { analyzeBursts, BURST_WINDOW_MS, type BurstWindow } from '../../core/requests/bursts.js';
import type { RequestClass } from '../../core/requests/classify.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { useInterval } from './useInterval.js';
import { useRenderMonitoring } from './useRenderMonitoring.js';

const TICK_MS = 1000;
// React Query 캐시 감시를 패널을 열기 전부터 시작하도록, 이 간격마다 화면의 QueryClient 를 찾는다(트리를 훑는 일이라 드물게).
const FIND_CLIENTS_EVERY = 5;
// 버튼을 깜빡이게 할 "방금" 의 범위
const RECENT_MS = 2000;
// 응답이 끝나고 이만큼 지난 뒤에 판정한다(응답 뒤에 오는 화면 이동을 기다린다, 화면 진입의 응답 뒤 1초 창과 같다).
const SETTLE_MS = 1000;

/** 최근 판정에 쓸 기록. 판정할 창의 요청이 빠지지 않게, 최근에 끝난 요청의 가장 이른 시작보다 창 하나만큼 앞부터 둔다. */
const recentRecords = (records: readonly RequestRecord[], now: number): RequestRecord[] => {
  const horizon = now - RECENT_MS - SETTLE_MS - BURST_WINDOW_MS;
  let cutoff = Infinity;
  for (const r of records) if (r.startedAt + r.durationMs >= horizon) cutoff = Math.min(cutoff, r.startedAt);
  return records.filter((r) => r.startedAt >= cutoff - BURST_WINDOW_MS);
};

/**
 * 지금 알릴 낭비 창. 화면 진입 창과 이유가 확실한 반복(무시·StrictMode)은 빼고 500ms 창 단위로 본다.
 * - 창의 응답이 모두 끝나고 1초가 지났다. 응답을 받은 뒤 주소를 바꾸는 데이터 라우터의 이동을 기다린다(알림은 최대 1초 늦다).
 * - 또는 창이 시작하고 1초가 지났고 몰림이 1초 넘게 이어진다. 끝나지 않는 반복도 1~2초 안에 알린다.
 */
const wasteWindowsToAlert = (records: readonly RequestRecord[], classOf: (r: RequestRecord) => RequestClass, now: number): BurstWindow[] =>
  analyzeBursts(recentRecords(records, now), classOf)
    .filter((seg) => !seg.entry)
    .flatMap((seg) =>
      seg.windows.filter(
        (w) =>
          (now - w.end >= SETTLE_MS && now - w.end <= SETTLE_MS + RECENT_MS) ||
          (seg.runTo - w.to >= SETTLE_MS && now - w.from >= SETTLE_MS && now - w.from <= SETTLE_MS + RECENT_MS),
      ),
    );

/**
 * 이미 알린 창(마지막 요청 시각 last 까지)에서 겹쳐 이어지는 창은 같은 몰림이라 다시 알리지 않는다.
 * 끝나지 않는 반복은 창이 계속 이어지므로 한 번만 알리고, 끊겼다 다시 생긴 몰림은 새로 알린다.
 */
const followBursts = (windows: readonly BurstWindow[], lastBurst: number): { last: number; fresh: boolean } => {
  let last = lastBurst;
  let fresh = false;
  for (const w of [...windows].sort((a, b) => a.from - b.from)) {
    if (w.from > last) fresh = true;
    last = Math.max(last, w.to);
  }
  return { last, fresh };
};

const NO_STORMS: ReadonlyMap<string, RenderStorm> = new Map();

interface Signal {
  /** 키: 렌더 그룹 키(이름 + 그리는 위치) */
  storming: ReadonlyMap<string, RenderStorm>;
  lastBurst: number;
  alert: boolean;
}

/**
 * RDX 버튼에 보여 줄 신호. 버튼은 패널을 닫아 둔 동안에도 알려야 하므로, 붙어 있는 동안 렌더 감시를 켠다.
 * - issues: 낭비 요청이 있는 엔드포인트 수 + 렌더 폭주 중인 컴포넌트 그룹 수. 보고서 summary.badge 와 같은 함수(core/problems.ts)로 센다
 * - wasteEndpoints·stormingNames: 배지가 센 항목의 이름(내역 표시용)
 * - alert: 새 요청 몰림이 생겼거나 새 컴포넌트가 렌더 폭주에 들어왔다(그 1초 동안만 켜진다)
 */
export const useProblemSignal = (
  records: readonly RequestRecord[],
  classOf: (r: RequestRecord) => RequestClass,
  endpoints: readonly WasteRow[] = [],
) => {
  useRenderMonitoring();
  const [signal, setSignal] = useState<Signal>({ storming: NO_STORMS, lastBurst: 0, alert: false });
  // 렌더에 쓰지 않는 횟수라 state 가 아니라 ref 에 센다(매초 다시 렌더하지 않게).
  const ticks = useRef(0);
  useInterval(() => {
    const now = Date.now();
    if (ticks.current++ % FIND_CLIENTS_EVERY === 0) findQueryClients();
    const storming = findRenderStorms(now);
    // useInterval 이 최신 콜백을 쓰므로 records 는 늘 지금 기록이다.
    const waste = wasteWindowsToAlert(records, classOf, now);
    setSignal((prev) => {
      const newStorm = [...storming.keys()].some((key) => !prev.storming.has(key));
      const { last, fresh } = followBursts(waste, prev.lastBurst);
      return { storming, lastBurst: last, alert: newStorm || fresh };
    });
  }, TICK_MS);
  // 배지 내역에 보일 이름. 폭주 이름은 시간 창 기준이라 시간이 지나면 빠진다.
  const problems = countProblems(endpoints, signal.storming);
  return {
    issues: problems.issues,
    alert: signal.alert,
    wasteEndpoints: problems.wasteEndpoints.map((e) => e.endpoint),
    // 같은 이름이 여러 위치에서 폭주해도 내역에는 이름을 한 번만 보인다(누르면 그 이름으로 렌더 탭을 연다).
    stormingNames: [...new Set([...signal.storming.values()].map((s) => s.name))].sort(),
  };
};
