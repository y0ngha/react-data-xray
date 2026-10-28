import { hookSitesOf, resolvedLocation } from '../fiber/hookPaths.js';
import type { Fiber } from '../fiber/types.js';
import { endpointOf } from '../requests/requestKey.js';
import {
  RENDER_REASONS,
  type NetworkCauseCount,
  type MemoStats,
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
    byOrigin.set(key, prev ? { ...prev, count: prev.count + 1 } : { name: origin.name, reason: origin.reason, count: 1 });
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

/**
 * "useCart › useState #2 (src/x.ts:12)": 훅 순번(코드에서 훅을 부른 순서)에 커스텀 훅 경로를 붙인다.
 * 경로는 dev 빌드의 훅 목록이 있을 때만, 위치는 소스맵이 풀렸을 때만 붙는다. 없으면 "useState #2" 그대로.
 */
export const stateHookLabel = (fiber: Fiber, hookIndex: number): string => {
  const type = fiber._debugHookTypes?.[hookIndex - 1];
  const base = hookLabel({ index: hookIndex, type });
  const site = type ? hookSitesOf(fiber)?.[hookIndex - 1] : undefined;
  if (!site) return base;
  const where = resolvedLocation(site.frame);
  return `${[...site.path, base].join(' › ')}${where ? ` (${where})` : ''}`;
};

/** state 때문에 렌더된 기록에서, 값이 바뀐 훅별 횟수·간격·최근 변경 */
const summarizeStateHooks = (events: RenderEntry['events'], fiber: unknown): StateHookSummary[] => {
  const byHook = new Map<string, { times: number[]; last: { from: string; to: string } }>();
  events.forEach((e) =>
    e.hooks?.forEach((h) => {
      const label = h.type && h.type !== 'this.state' ? stateHookLabel(fiber as Fiber, h.index) : hookLabel(h);
      const prev = byHook.get(label);
      byHook.set(label, { times: [...(prev?.times ?? []), e.time], last: { from: h.from, to: h.to } });
    }),
  );
  return [...byHook.entries()]
    .map(([label, { times, last }]) => ({ label, count: times.length, intervalMs: regularInterval(times), last }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_STATE_HOOKS);
};

const memoStatsOf = (skipped: number, reasons: Record<RenderReason, number>, keys: string[]): MemoStats => {
  const rendered = Object.values(reasons).reduce((a, b) => a + b, 0) - reasons.mount;
  return { skipped, rendered, neverSkippedProps: skipped === 0 && rendered > 0 ? keys : [] };
};

/** 최근 windowMs(기본 10초) 렌더 요약 */
export const summarize = (entry: RenderEntry, now: number, windowMs = WINDOW_MS): RenderSummary => {
  const recent = entry.events.filter((e) => e.time >= now - windowMs);
  const reasons = countReasons(recent.map((e) => e.reason));
  // 이미 React.memo 인데 부모 때문에 렌더됐다면(forceUpdate 등) memo 로는 줄일 수 없으니 세지 않는다.
  const avoidable = reasons['same-content'] + reasons['new-callback'] + (entry.memoized ? 0 : reasons.parent);
  const isAvoidable = (r: RenderReason): boolean => r === 'same-content' || r === 'new-callback' || (r === 'parent' && !entry.memoized);
  const sameContentKeys = keysOf(recent, 'same-content');
  const callbackKeys = keysOf(recent, 'new-callback');
  // React Compiler 의 메모는 건너뜀을 셀 수 없어 제외한다.
  const memo =
    entry.memoized && !entry.compiled
      ? memoStatsOf((entry.skips ?? []).filter((t) => t >= now - windowMs).length, reasons, [...callbackKeys, ...sameContentKeys])
      : undefined;
  return {
    recent: recent.length,
    last: entry.events[entry.events.length - 1]?.time ?? 0,
    ms: recent.reduce((sum, e) => sum + (e.ms ?? 0), 0),
    timed: recent.filter((e) => e.ms !== undefined).length,
    avoidableMs: recent.reduce((sum, e) => sum + (isAvoidable(e.reason) ? (e.ms ?? 0) : 0), 0),
    reasons,
    avoidable,
    sameContentKeys,
    callbackKeys,
    contextKeys: keysOf(recent, 'context'),
    memoized: entry.memoized,
    network: recent.filter((e) => e.cause).length,
    causes: countCauses(recent),
    origins: countOrigins(recent),
    stateHooks: summarizeStateHooks(recent, entry.fiber),
    compiled: !!entry.compiled,
    memo,
  };
};
