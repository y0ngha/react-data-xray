import {
  getComponentName,
  isFrameworkDevtoolsRoot,
  isMemoized,
  jsxLocationOf,
  rememberRootContainer,
  resolveJsxLocation,
} from '../fiber/tree.js';
import { isComposite, PERFORMED_WORK, type Fiber } from '../fiber/types.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { listenToCommits } from './devtoolsHook.js';
import { groupRenders, type RenderGroup } from './groups.js';
import { causeOf } from './networkCause.js';
import { reasonOf } from './renderReason.js';
import { summarize, WINDOW_MS } from './summary.js';
import type { Commit, NetworkCause, RenderEntry, RenderEvent, RenderOrigin, RenderReason, RenderSummary } from './types.js';

const MAX_EVENTS_PER_COMPONENT = 200;
// 보고서가 측정 시작(reset) 뒤 구간을 볼 수 있게, 렌더가 멈춘 컴포넌트도 이만큼은 남긴다.
const MAX_REPORT_WINDOW_MS = 120_000;
// 마지막 reset 시각(한 번도 안 했으면 0)
let measuredFrom = 0;
const MAX_COMMITS = 500;
// 보고서·렌더 탭이 합치는 인스턴스 상한(이름별로 합치기 전 기준). 넘으면 truncated 로 알린다.
export const MAX_GROUPED_INSTANCES = 5000;

/** React 19 의 React Compiler 는 컴포넌트마다 메모 캐시를 updateQueue.memoCache 에 둔다. */
const isCompiled = (fiber: Fiber): boolean => !!(fiber.updateQueue as { memoCache?: unknown } | null | undefined)?.memoCache;

/** 자식에게 물려주는 것: 네트워크 원인과, 이 렌더를 시작한 조상 */
interface Inherited {
  cause?: NetworkCause;
  origin?: RenderOrigin;
}

const commits: Commit[] = [];
const entries = new WeakMap<Fiber, RenderEntry>();
const active = new Set<RenderEntry>();
const ignoredTypes = new Set<unknown>();
const commitListeners = new Set<() => void>();
let commitSeq = 0;
// 렌더 탭, 타임라인, 전체 표시가 동시에 켤 수 있어 사용 수를 센다.
let users = 0;
// reset·감시 중단 때 올린다. 그 전에 걸린 분석 step 은 버린다.
let epoch = 0;

// alt·memoized·compiled 는 commit 시점 값이다. 언마운트되면 React 가 alternate·return·updateQueue 를 비운다.
const entryOf = (fiber: Fiber, alt: Fiber | null, memoized: boolean, compiled: boolean): RenderEntry => {
  const existing = entries.get(fiber) ?? (alt ? entries.get(alt) : undefined);
  const entry = existing ?? {
    name: getComponentName(fiber),
    events: [],
    fiber,
    memoized,
    location: jsxLocationOf(fiber),
    compiled,
  };
  if (!existing) {
    // React 19 의 위치는 변환된 코드 기준이라, 소스맵을 받는 대로 원본 줄로 바꾼다.
    void resolveJsxLocation(fiber)
      .then((location) => {
        if (location) entry.location = location;
      })
      .catch(() => undefined);
  }
  entries.set(fiber, entry);
  if (alt) entries.set(alt, entry);
  return entry;
};

// 스스로 렌더를 시작하는 이유. 나머지(props·같은 내용·새 콜백·부모)는 조상이 시작한 렌더를 따라온 것이다.
const STARTS_RENDER = new Set<RenderReason>(['mount', 'state', 'context']);

/** 이번 commit 에서 렌더된 컴포넌트를 기록한다. snap 은 commit 시점 값의 사본(React 가 fiber 를 재사용해 덮어쓴다). */
const recordRender = (p: Pending, now: number, inherited: Inherited): RenderEvent => {
  const { fiber, snap } = p;
  const entry = entryOf(fiber, p.alt, p.memoized, p.compiled);
  const result = reasonOf(snap);
  const startsRender = STARTS_RENDER.has(result.reason);
  const event: RenderEvent = {
    time: now,
    ms: typeof snap.selfBaseDuration === 'number' ? snap.selfBaseDuration : undefined,
    reason: result.reason,
    keys: result.keys,
    hooks: result.hooks,
    cause: causeOf(result, inherited.cause, now),
    origin: startsRender ? undefined : inherited.origin,
  };
  entry.fiber = fiber;
  entry.events.push(event);
  if (entry.events.length > MAX_EVENTS_PER_COMPONENT) entry.events.shift();
  active.add(entry);
  return event;
};

const CHUNK = 32;

interface Pending {
  fiber: Fiber;
  snap: Fiber;
  alt: Fiber | null;
  memoized: boolean;
  compiled: boolean;
  parent: number;
}

const shape = (f: Fiber): Record<string, unknown> => ({
  tag: f.tag,
  memoizedProps: f.memoizedProps,
  memoizedState: f.memoizedState,
  _debugHookTypes: f._debugHookTypes,
  dependencies: { firstContext: f.dependencies?.firstContext ?? null },
});

const snapshotOf = (f: Fiber): Fiber =>
  ({ ...shape(f), selfBaseDuration: f.selfBaseDuration, alternate: f.alternate ? shape(f.alternate) : null }) as unknown as Fiber;

// React DevTools 처럼 이번 commit 에서 다시 만든 서브트리만 내려간다. 재사용된 서브트리의 fiber 는
// 지난 렌더의 PerformedWork 플래그가 남아 있어, 들어가면 렌더하지 않은 것을 렌더로 센다.
const wasRecreated = (fiber: Fiber): boolean => !fiber.alternate || fiber.child !== fiber.alternate.child;

const onCommit = (root: { current: Fiber; containerInfo?: unknown }): void => {
  if (isFrameworkDevtoolsRoot(root.containerInfo)) return;
  rememberRootContainer(root);
  if (users === 0) return;
  const now = Date.now();
  const pending: Pending[] = [];
  // commit 안에서는 렌더된 fiber 의 참조만 모으고, 분석은 큐에서 한다.
  const visit = (fiber: Fiber | null, parent: number): void => {
    for (let f = fiber; f; f = f.sibling) {
      if (ignoredTypes.has(f.type)) continue;
      const rendered = isComposite(f) && (f.flags & PERFORMED_WORK) !== 0;
      let next = parent;
      if (rendered) {
        next =
          pending.push({ fiber: f, snap: snapshotOf(f), alt: f.alternate, memoized: isMemoized(f), compiled: isCompiled(f), parent }) - 1;
      }
      if (f.child && wasRecreated(f)) visit(f.child, next);
    }
  };
  if (wasRecreated(root.current)) visit(root.current.child, -1);
  if (pending.length === 0) return;
  const inheritedBy: Inherited[] = [];
  let at = 0;
  const mine = epoch;
  // 위에서 아래로 내려가며, 가장 가까운 렌더된 조상의 네트워크 원인과 렌더를 시작한 조상을 자식에게 넘긴다.
  enqueue(() => {
    if (mine !== epoch) return true;
    for (const end = Math.min(at + CHUNK, pending.length); at < end; at++) {
      const p = pending[at];
      inheritedBy[at] = {}; // 한 fiber 가 던져도 나머지와 commit 기록·구독자 알림은 이어간다
      try {
        const event = recordRender(p, now, p.parent < 0 ? {} : inheritedBy[p.parent]);
        inheritedBy[at] = { cause: event.cause, origin: event.origin ?? { name: getComponentName(p.fiber), reason: event.reason } };
      } catch {
        /* 이 fiber 만 건너뛴다 */
      }
    }
    if (at < pending.length) return false;
    commits.push({ id: ++commitSeq, time: now, count: pending.length });
    if (commits.length > MAX_COMMITS) commits.shift();
    commitListeners.forEach((listener) => listener());
    return true;
  });
};

if (process.env.NODE_ENV !== 'production') listenToCommits(onCommit);

/** 렌더가 있었던 commit 마다 부른다. */
export const subscribeCommits = (listener: () => void): (() => void) => {
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
};

/** 렌더 감시를 켜고 끈다. 여러 곳에서 켤 수 있어 켠 수만큼 꺼야 멈춘다. */
export const setRenderMonitoring = (on: boolean): void => {
  users = Math.max(0, users + (on ? 1 : -1));
  if (users > 0) return;
  epoch++;
  active.clear();
  commits.length = 0;
};

export const isRenderMonitoring = (): boolean => users > 0;

/** 지금까지의 렌더 통계를 비운다(측정 시나리오를 새로 시작할 때). 감시는 켜 둔 채로 둔다. */
export const resetRenderStats = (): void => {
  measuredFrom = Date.now();
  active.forEach((entry) => {
    entry.events.length = 0;
  });
  epoch++;
  active.clear();
  commits.length = 0;
};

/** 이 컴포넌트와 그 하위는 세지 않는다(rdx 패널 자신). */
export const ignoreComponent = (type: unknown): void => {
  ignoredTypes.add(type);
};

export const getCommits = (): readonly Commit[] => commits;

/** 컴포넌트(fiber) 하나의 최근 10초 렌더 요약 */
export const getRenderInfo = (fiber: unknown, now = Date.now()): RenderSummary | null => {
  const f = fiber as Fiber;
  const entry = entries.get(f) ?? (f.alternate ? entries.get(f.alternate) : undefined);
  return entry ? summarize(entry, now) : null;
};

/** 보고서가 볼 구간: reset 했으면 그 뒤 전부(10초~2분), 아니면 최근 10초 */
export const reportWindowMs = (now = Date.now()): number =>
  measuredFrom ? Math.min(MAX_REPORT_WINDOW_MS, Math.max(WINDOW_MS, now - measuredFrom)) : WINDOW_MS;

/** 렌더 탭이 표시할 구간의 시작: reset 했으면 reset 시각(최대 2분 전), 아니면 10초 전 */
export const renderWindowStart = (now = Date.now()): number =>
  measuredFrom ? Math.max(measuredFrom, now - MAX_REPORT_WINDOW_MS) : now - WINDOW_MS;

// 렌더 기록이 그대로인 컴포넌트는 지난 요약을 다시 쓴다(탭이 1초마다 수천 개를 처음부터 요약하지 않게).
// 기록 끝, 창 안 첫 기록, 창 안 개수가 같으면 창 안 기록이 같다(기록은 시간순으로 쌓인다).
const summaries = new WeakMap<
  RenderEntry,
  { first?: RenderEvent; last?: RenderEvent; recent: number; windowMs: number; value: RenderSummary }
>();

const summaryOf = (entry: RenderEntry, now: number, windowMs: number): RenderSummary => {
  const { events } = entry;
  const cutoff = now - windowMs;
  const at = events.findIndex((e) => e.time >= cutoff);
  const recent = at < 0 ? 0 : events.length - at;
  const first = at < 0 ? undefined : events[at];
  const last = events[events.length - 1];
  const hit = summaries.get(entry);
  if (hit && hit.first === first && hit.last === last && hit.recent === recent && hit.windowMs === windowMs) return hit.value;
  const value = summarize(entry, now, windowMs);
  summaries.set(entry, { first, last, recent, windowMs, value });
  return value;
};

const recentRenders = (now: number, keep: (entry: RenderEntry) => boolean, windowMs: number): Array<RenderEntry & RenderSummary> => {
  // 오래 렌더되지 않은 컴포넌트는 빼 둔다. 안 그러면 한 번이라도 렌더된 컴포넌트를 매번 다 요약한다.
  const keepFor = measuredFrom ? MAX_REPORT_WINDOW_MS : Math.max(WINDOW_MS, windowMs);
  active.forEach((e) => {
    if ((e.events[e.events.length - 1]?.time ?? 0) < now - keepFor) active.delete(e);
  });
  return Array.from(active)
    .filter(keep)
    .map((e) => Object.assign({}, summaryOf(e, now, windowMs), e))
    .filter((e) => e.recent > 0)
    .sort((a, b) => b.recent - a.recent);
};

/** 최근 windowMs(기본 10초) 렌더가 있는 컴포넌트들(렌더 많은 순) */
export const getTopRenders = (
  limit = 20,
  now = Date.now(),
  /** 자르기 전에 거른다(분석 대상 안의 렌더만 볼 때). 자른 뒤에 거르면 대상 안의 렌더가 빠질 수 있다. */
  keep: (entry: RenderEntry) => boolean = () => true,
  windowMs = WINDOW_MS,
): Array<RenderEntry & RenderSummary> => recentRenders(now, keep, windowMs).slice(0, limit);

/**
 * 이름별로 합친 렌더 그룹. 인스턴스를 먼저 자르면 목록 행이 일부만 남으므로 합친 뒤에 센다.
 * 인스턴스가 MAX_GROUPED_INSTANCES 를 넘을 때만 렌더 적은 인스턴스를 버리고 truncated 로 알린다.
 */
export const getRenderGroups = (
  now = Date.now(),
  sinceMs = WINDOW_MS,
  keep: (entry: RenderEntry) => boolean = () => true,
): { groups: RenderGroup[]; truncated: boolean; droppedInstances: number } => {
  const all = recentRenders(now, keep, sinceMs);
  const droppedInstances = Math.max(0, all.length - MAX_GROUPED_INSTANCES);
  return {
    groups: groupRenders(all.slice(0, MAX_GROUPED_INSTANCES), now - sinceMs),
    truncated: droppedInstances > 0,
    droppedInstances,
  };
};
