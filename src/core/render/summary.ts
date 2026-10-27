import { endpointOf } from '../requests/requestKey.js';
import {
  RENDER_REASONS,
  type NetworkCauseCount,
  type OriginCount,
  type RenderEntry,
  type RenderReason,
  type RenderSummary,
  type StateHookSummary,
} from './types.js';

export const WINDOW_MS = 10_000;

const countReasons = (reasons: readonly RenderReason[]): Record<RenderReason, number> =>
  Object.fromEntries(RENDER_REASONS.map((r) => [r, reasons.filter((x) => x === r).length])) as Record<RenderReason, number>;

const keysOf = (entry: RenderEntry['events'], reason: RenderReason): string[] =>
  Array.from(new Set(entry.filter((e) => e.reason === reason).flatMap((e) => e.keys ?? [])));

const countCauses = (events: RenderEntry['events']): NetworkCauseCount[] => {
  const byEndpoint = events.reduce((acc, { cause }) => {
    if (!cause) return acc;
    const key = endpointOf(cause.record);
    const prev = acc.get(key) ?? { record: cause.record, direct: 0, timing: 0, parent: 0, sameResponse: 0 };
    const sameResponse = prev.sameResponse + (cause.record.sameResponseAs ? 1 : 0);
    return acc.set(key, { ...prev, record: cause.record, sameResponse, [cause.via]: prev[cause.via] + 1 });
  }, new Map<string, NetworkCauseCount>());
  return Array.from(byEndpoint.values()).sort((a, b) => b.direct + b.parent - (a.direct + a.parent));
};

const MAX_ORIGINS = 3;

/** 조상 때문에 렌더됐을 때, 그 렌더를 시작한 조상(이름·이유) 별 횟수 */
const countOrigins = (events: RenderEntry['events']): OriginCount[] => {
  const byOrigin = new Map<string, OriginCount>();
  events.forEach(({ origin }) => {
    if (!origin) return;
    const key = `${origin.name}|${origin.reason}`;
    const prev = byOrigin.get(key);
    byOrigin.set(key, prev ? { ...prev, count: prev.count + 1 } : { ...origin, count: 1 });
  });
  return [...byOrigin.values()].sort((a, b) => b.count - a.count).slice(0, MAX_ORIGINS);
};

const MAX_STATE_HOOKS = 3;
// 이만큼 이상 바뀌어야 간격을 따진다(두 번은 우연일 수 있다).
const MIN_CHANGES_FOR_INTERVAL = 3;
// 간격이 중앙값에서 이만큼 안에 들면 일정하다고 본다(요청의 주기 판정과 같은 기준).
const INTERVAL_TOLERANCE = 0.25;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** 바뀐 시각들이 일정한 간격이면 그 간격(ms) */
export const regularInterval = (times: readonly number[]): number | undefined => {
  if (times.length < MIN_CHANGES_FOR_INTERVAL) return undefined;
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const mid = median(gaps);
  return mid > 0 && gaps.every((g) => Math.abs(g - mid) <= mid * INTERVAL_TOLERANCE) ? mid : undefined;
};

const hookLabel = (h: { index: number; type?: string }): string => (h.type ? `${h.type} #${h.index}` : `훅 칸 #${h.index}`);

/** state 때문에 렌더된 기록에서, 값이 바뀐 훅별 횟수·간격·최근 변경 */
const summarizeStateHooks = (events: RenderEntry['events']): StateHookSummary[] => {
  const byHook = new Map<string, { times: number[]; last: { from: string; to: string } }>();
  events.forEach((e) =>
    e.hooks?.forEach((h) => {
      const label = hookLabel(h);
      const prev = byHook.get(label);
      byHook.set(label, { times: [...(prev?.times ?? []), e.time], last: { from: h.from, to: h.to } });
    }),
  );
  return [...byHook.entries()]
    .map(([label, { times, last }]) => ({ label, count: times.length, intervalMs: regularInterval(times), last }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_STATE_HOOKS);
};

/** 최근 windowMs(기본 10초) 렌더 요약 */
export const summarize = (entry: RenderEntry, now: number, windowMs = WINDOW_MS): RenderSummary => {
  const recent = entry.events.filter((e) => e.time >= now - windowMs);
  const reasons = countReasons(recent.map((e) => e.reason));
  // 이미 React.memo 인데 부모 때문에 렌더됐다면(forceUpdate 등) memo 로는 줄일 수 없으니 세지 않는다.
  const avoidable = reasons['same-content'] + reasons['new-callback'] + (entry.memoized ? 0 : reasons.parent);
  return {
    recent: recent.length,
    last: entry.events[entry.events.length - 1]?.time ?? 0,
    ms: recent.reduce((sum, e) => sum + (e.ms ?? 0), 0),
    reasons,
    avoidable,
    sameContentKeys: keysOf(recent, 'same-content'),
    callbackKeys: keysOf(recent, 'new-callback'),
    contextKeys: keysOf(recent, 'context'),
    memoized: entry.memoized,
    network: recent.filter((e) => e.cause).length,
    causes: countCauses(recent),
    origins: countOrigins(recent),
    stateHooks: summarizeStateHooks(recent),
    compiled: !!entry.compiled,
  };
};
