import { getComponentName, isFrameworkDevtoolsRoot, isMemoized, jsxLocationOf, rememberRootContainer } from '../fiber/tree.js';
import { isComposite, PERFORMED_WORK, type Fiber } from '../fiber/types.js';
import { listenToCommits } from './devtoolsHook.js';
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

const entryOf = (fiber: Fiber): RenderEntry => {
  const existing = entries.get(fiber) ?? (fiber.alternate ? entries.get(fiber.alternate) : undefined);
  const entry = existing ?? {
    name: getComponentName(fiber),
    events: [],
    fiber,
    memoized: isMemoized(fiber),
    location: jsxLocationOf(fiber),
  };
  entries.set(fiber, entry);
  if (fiber.alternate) entries.set(fiber.alternate, entry);
  return entry;
};

// 스스로 렌더를 시작하는 이유. 나머지(props·같은 내용·새 콜백·부모)는 조상이 시작한 렌더를 따라온 것이다.
const STARTS_RENDER = new Set<RenderReason>(['mount', 'state', 'context']);

/** 이번 commit 에서 렌더된 컴포넌트를 기록한다. */
const recordRender = (fiber: Fiber, now: number, inherited: Inherited): RenderEvent => {
  const entry = entryOf(fiber);
  const result = reasonOf(fiber);
  const startsRender = STARTS_RENDER.has(result.reason);
  const event: RenderEvent = {
    time: now,
    ms: typeof fiber.selfBaseDuration === 'number' ? fiber.selfBaseDuration : undefined,
    reason: result.reason,
    keys: result.keys,
    cause: causeOf(result, inherited.cause, now),
    origin: startsRender ? undefined : inherited.origin,
  };
  entry.fiber = fiber;
  // React commit 안에서 도는 코드라 배열을 복사하지 않는다.
  entry.events.push(event);
  if (entry.events.length > MAX_EVENTS_PER_COMPONENT) entry.events.shift();
  active.add(entry);
  return event;
};

// React DevTools 처럼 이번 commit 에서 다시 만든 서브트리만 내려간다. 재사용된 서브트리의 fiber 는
// 지난 렌더의 PerformedWork 플래그가 남아 있어, 들어가면 렌더하지 않은 것을 렌더로 센다.
const wasRecreated = (fiber: Fiber): boolean => !fiber.alternate || fiber.child !== fiber.alternate.child;

const onCommit = (root: { current: Fiber; containerInfo?: unknown }): void => {
  if (isFrameworkDevtoolsRoot(root.containerInfo)) return;
  rememberRootContainer(root);
  if (users === 0) return;
  const now = Date.now();
  let count = 0;
  // 위에서 아래로 내려가며, 가장 가까운 렌더된 조상의 네트워크 원인과 렌더를 시작한 조상을 자식에게 넘긴다.
  const visit = (fiber: Fiber | null, inherited: Inherited): void => {
    for (let f = fiber; f; f = f.sibling) {
      if (ignoredTypes.has(f.type)) continue;
      const rendered = isComposite(f) && (f.flags & PERFORMED_WORK) !== 0;
      const event = rendered ? recordRender(f, now, inherited) : undefined;
      count += rendered ? 1 : 0;
      const next: Inherited = event
        ? { cause: event.cause, origin: event.origin ?? { name: getComponentName(f), reason: event.reason } }
        : inherited;
      if (f.child && wasRecreated(f)) visit(f.child, next);
    }
  };
  if (wasRecreated(root.current)) visit(root.current.child, {});
  if (count === 0) return;
  commits.push({ id: ++commitSeq, time: now, count });
  if (commits.length > MAX_COMMITS) commits.shift();
  commitListeners.forEach((listener) => listener());
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

/** 최근 windowMs(기본 10초) 렌더가 있는 컴포넌트들(렌더 많은 순) */
export const getTopRenders = (
  limit = 20,
  now = Date.now(),
  /** 자르기 전에 거른다(분석 대상 안의 렌더만 볼 때). 자른 뒤에 거르면 대상 안의 렌더가 빠질 수 있다. */
  keep: (entry: RenderEntry) => boolean = () => true,
  windowMs = WINDOW_MS,
): Array<RenderEntry & RenderSummary> => {
  // 오래 렌더되지 않은 컴포넌트는 빼 둔다. 안 그러면 한 번이라도 렌더된 컴포넌트를 매번 다 요약한다.
  const keepFor = measuredFrom ? MAX_REPORT_WINDOW_MS : Math.max(WINDOW_MS, windowMs);
  active.forEach((e) => {
    if ((e.events[e.events.length - 1]?.time ?? 0) < now - keepFor) active.delete(e);
  });
  return Array.from(active)
    .filter(keep)
    .map((e) => Object.assign(summarize(e, now, windowMs), e))
    .filter((e) => e.recent > 0)
    .sort((a, b) => b.recent - a.recent)
    .slice(0, limit);
};
