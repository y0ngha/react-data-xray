import { endpointOf } from '../requests/requestKey.js';
import {
  RENDER_REASONS,
  type NetworkCauseCount,
  type OriginCount,
  type RenderEntry,
  type RenderReason,
  type RenderSummary,
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
    const prev = acc.get(key) ?? { record: cause.record, direct: 0, parent: 0, sameResponse: 0 };
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

/** 최근 10초 렌더 요약 */
export const summarize = (entry: RenderEntry, now: number): RenderSummary => {
  const recent = entry.events.filter((e) => e.time >= now - WINDOW_MS);
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
  };
};
