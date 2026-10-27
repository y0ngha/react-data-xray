import { endpointOf } from '../requests/requestKey.js';
import { RENDER_REASONS, type NetworkCauseCount, type RenderEntry, type RenderSummary } from './types.js';

export interface RenderGroup extends RenderSummary {
  name: string;
  instances: number;
  fiber: unknown;
}

const union = (a: readonly string[], b: readonly string[]): string[] => Array.from(new Set([...a, ...b]));

const mergeCauses = (a: readonly NetworkCauseCount[], b: readonly NetworkCauseCount[]): NetworkCauseCount[] => {
  const byEndpoint = [...a, ...b].reduce((acc, c) => {
    const key = endpointOf(c.record);
    const prev = acc.get(key);
    return acc.set(key, prev ? { ...prev, direct: prev.direct + c.direct, parent: prev.parent + c.parent } : { ...c });
  }, new Map<string, NetworkCauseCount>());
  return Array.from(byEndpoint.values());
};

const merge = (g: RenderGroup, e: RenderEntry & RenderSummary): RenderGroup => ({
  ...g,
  recent: g.recent + e.recent,
  ms: g.ms + e.ms,
  avoidable: g.avoidable + e.avoidable,
  network: g.network + e.network,
  instances: g.instances + 1,
  reasons: Object.fromEntries(RENDER_REASONS.map((r) => [r, g.reasons[r] + e.reasons[r]])) as RenderGroup['reasons'],
  sameContentKeys: union(g.sameContentKeys, e.sameContentKeys),
  callbackKeys: union(g.callbackKeys, e.callbackKeys),
  contextKeys: union(g.contextKeys, e.contextKeys),
  causes: mergeCauses(g.causes, e.causes),
});

/** 같은 컴포넌트가 여러 개 렌더되면(목록의 행 등) 이름별로 합친다. */
export const groupRenders = (renders: ReadonlyArray<RenderEntry & RenderSummary>): RenderGroup[] => {
  const grouped = renders.reduce((acc, e) => {
    const g = acc.get(e.name);
    return acc.set(e.name, g ? merge(g, e) : { ...e, instances: 1 });
  }, new Map<string, RenderGroup>());
  return Array.from(grouped.values());
};

export type RenderSort = 'avoidable' | 'count' | 'time';

const sortKey: Record<RenderSort, (g: RenderGroup) => number> = {
  avoidable: (g) => g.avoidable * 1000 + g.recent,
  count: (g) => g.recent,
  time: (g) => g.ms,
};

export const sortRenderGroups = (groups: readonly RenderGroup[], sort: RenderSort): RenderGroup[] =>
  groups.toSorted((a, b) => sortKey[sort](b) - sortKey[sort](a));
