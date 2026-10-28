import { endpointOf } from '../requests/requestKey.js';
import type { Fiber } from '../fiber/types.js';
import {
  RENDER_REASONS,
  type MemoStats,
  type NetworkCauseCount,
  type OriginCount,
  type OriginImpact,
  type RenderEntry,
  type RenderEvent,
  type RenderSummary,
  type StateHookSummary,
} from './types.js';

export interface RenderGroup extends RenderSummary {
  name: string;
  instances: number;
  fiber: unknown;
  /** 이 컴포넌트를 그리는 JSX 위치(첫 인스턴스) */
  location?: string;
  /** 이 컴포넌트가 시작한 렌더가 하위에 미친 영향(시작한 적이 있을 때만) */
  impact?: OriginImpact;
}

const union = (a: readonly string[], b: readonly string[]): string[] => Array.from(new Set([...a, ...b]));

const mergeCauses = (a: readonly NetworkCauseCount[], b: readonly NetworkCauseCount[]): NetworkCauseCount[] => {
  const byEndpoint = [...a, ...b].reduce((acc, c) => {
    const key = endpointOf(c.record);
    const prev = acc.get(key);
    return acc.set(
      key,
      prev
        ? {
            ...prev,
            direct: prev.direct + c.direct,
            timing: prev.timing + c.timing,
            parent: prev.parent + c.parent,
            sameResponse: prev.sameResponse + c.sameResponse,
          }
        : { ...c },
    );
  }, new Map<string, NetworkCauseCount>());
  return Array.from(byEndpoint.values());
};

const mergeOrigins = (a: readonly OriginCount[], b: readonly OriginCount[]): OriginCount[] => {
  const byOrigin = new Map<string, OriginCount>();
  [...a, ...b].forEach((o) => {
    const key = `${o.name}|${o.reason}`;
    const prev = byOrigin.get(key);
    byOrigin.set(key, prev ? { ...prev, count: prev.count + o.count } : { ...o });
  });
  return [...byOrigin.values()].sort((x, y) => y.count - x.count).slice(0, 3);
};

const mergeStateHooks = (a: readonly StateHookSummary[], b: readonly StateHookSummary[]): StateHookSummary[] => {
  const byLabel = new Map<string, StateHookSummary>();
  [...a, ...b].forEach((h) => {
    const prev = byLabel.get(h.label);
    byLabel.set(h.label, prev ? { ...prev, count: prev.count + h.count, intervalMs: prev.intervalMs ?? h.intervalMs } : { ...h });
  });
  return [...byLabel.values()].sort((x, y) => y.count - x.count).slice(0, 3);
};

const mergeMemo = (a?: MemoStats, b?: MemoStats): MemoStats | undefined => {
  if (!a || !b) return a ?? b;
  const skipped = a.skipped + b.skipped;
  return {
    skipped,
    rendered: a.rendered + b.rendered,
    neverSkippedProps: skipped === 0 ? union(a.neverSkippedProps, b.neverSkippedProps) : [],
  };
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
  origins: mergeOrigins(g.origins, e.origins),
  stateHooks: mergeStateHooks(g.stateHooks, e.stateHooks),
  compiled: g.compiled || e.compiled,
  memo: mergeMemo(g.memo, e.memo),
  location: g.location ?? e.location,
});

/** 값이 그대로인데 따라 렌더된 것: 부모를 따라, 내용이 같은 새 참조, 새 콜백. children 만 바뀐 것도 같다(부모가 렌더되면 늘 새 element). */
const isUnchanged = (e: RenderEvent): boolean =>
  e.reason === 'parent' ||
  e.reason === 'same-content' ||
  e.reason === 'new-callback' ||
  (e.reason === 'props' && !!e.keys?.every((k) => k === 'children'));

const depthOf = (fiber: unknown): number => {
  let depth = 0;
  for (let f = (fiber as Fiber | null)?.return ?? null; f; f = f.return) depth++;
  return depth;
};

/**
 * 렌더를 시작한 컴포넌트별로, 하위가 얼마나 따라 렌더됐고 그중 값이 실제로 바뀐 props 는 무엇인지 모은다.
 * since 이후의 기록만 본다.
 */
export const originImpacts = (renders: ReadonlyArray<RenderEntry>, since: number): Map<string, OriginImpact> => {
  const acc = new Map<string, { renders: number; unchanged: number; unchangedNames: Set<string>; changed: Map<string, number> }>();
  renders.forEach((entry) =>
    entry.events.forEach((e) => {
      if (e.time < since || !e.origin) return;
      const cur = acc.get(e.origin.name) ?? {
        renders: 0,
        unchanged: 0,
        unchangedNames: new Set<string>(),
        changed: new Map<string, number>(),
      };
      cur.renders++;
      if (isUnchanged(e)) {
        cur.unchanged++;
        cur.unchangedNames.add(entry.name);
      } else if (e.reason === 'props') {
        // 위에서 아래 순서로 보여 주려고 깊이를 같이 둔다.
        e.keys?.filter((k) => k !== 'children').forEach((k) => cur.changed.set(`${entry.name}.${k}`, depthOf(entry.fiber)));
      }
      acc.set(e.origin.name, cur);
    }),
  );
  return new Map(
    [...acc.entries()].map(([name, a]) => [
      name,
      {
        renders: a.renders,
        unchanged: a.unchanged,
        unchangedComponents: a.unchangedNames.size,
        changedProps: [...a.changed.entries()].sort((x, y) => x[1] - y[1]).map(([prop]) => prop),
      },
    ]),
  );
};

/**
 * 같은 컴포넌트가 여러 개 렌더되면(목록의 행 등) 이름별로 합친다.
 * since 를 주면 그 이후 기록으로 각 컴포넌트가 시작한 렌더의 영향(impact)도 붙인다.
 */
export const groupRenders = (renders: ReadonlyArray<RenderEntry & RenderSummary>, since?: number): RenderGroup[] => {
  const grouped = renders.reduce((acc, e) => {
    const g = acc.get(e.name);
    return acc.set(e.name, g ? merge(g, e) : { ...e, instances: 1 });
  }, new Map<string, RenderGroup>());
  if (since === undefined) return Array.from(grouped.values());
  const impacts = originImpacts(renders, since);
  // 그룹은 위에서 새로 만든 객체라 그대로 채워도 된다.
  return Array.from(grouped.values(), (g) => Object.assign(g, { impact: impacts.get(g.name) }));
};

export type RenderSort = 'avoidable' | 'count' | 'time';

const sortKey: Record<RenderSort, (g: RenderGroup) => number> = {
  // 하위를 헛렌더시킨 시작점도 함께 올린다. 고칠 곳은 대개 그 컴포넌트다.
  avoidable: (g) => (g.avoidable + (g.impact?.unchanged ?? 0)) * 1000 + g.recent,
  count: (g) => g.recent,
  time: (g) => g.ms,
};

export const sortRenderGroups = (groups: readonly RenderGroup[], sort: RenderSort): RenderGroup[] =>
  [...groups].sort((a, b) => sortKey[sort](b) - sortKey[sort](a));
