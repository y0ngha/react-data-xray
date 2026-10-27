import { getComponentName, isMemoized } from '../fiber/tree.js';
import { isComposite, PERFORMED_WORK, type Fiber } from '../fiber/types.js';
import { listenToCommits } from './devtoolsHook.js';
import { causeOf } from './networkCause.js';
import { reasonOf } from './renderReason.js';
import { summarize } from './summary.js';
import type { Commit, NetworkCause, RenderEntry, RenderEvent, RenderSummary } from './types.js';

const MAX_EVENTS_PER_COMPONENT = 200;
const MAX_COMMITS = 500;

const commits: Commit[] = [];
const entries = new WeakMap<Fiber, RenderEntry>();
const active = new Set<RenderEntry>();
const ignoredTypes = new Set<unknown>();
const commitListeners = new Set<() => void>();
// 렌더 탭, 타임라인, 전체 표시가 동시에 켤 수 있어 사용 수를 센다.
let users = 0;

const entryOf = (fiber: Fiber): RenderEntry => {
  const existing = entries.get(fiber) ?? (fiber.alternate ? entries.get(fiber.alternate) : undefined);
  const entry = existing ?? { name: getComponentName(fiber), events: [], fiber, memoized: isMemoized(fiber) };
  entries.set(fiber, entry);
  if (fiber.alternate) entries.set(fiber.alternate, entry);
  return entry;
};

/** 이번 commit 에서 렌더된 컴포넌트를 기록한다. */
const recordRender = (fiber: Fiber, now: number, inherited: NetworkCause | undefined): RenderEvent => {
  const entry = entryOf(fiber);
  const result = reasonOf(fiber);
  const event: RenderEvent = {
    time: now,
    ms: typeof fiber.selfBaseDuration === 'number' ? fiber.selfBaseDuration : undefined,
    reason: result.reason,
    keys: result.keys,
    cause: causeOf(result, inherited, now),
  };
  entry.fiber = fiber;
  entry.events = [...entry.events, event].slice(-MAX_EVENTS_PER_COMPONENT);
  active.add(entry);
  return event;
};

// React DevTools 처럼 이번 commit 에서 다시 만든 서브트리만 내려간다. 재사용된 서브트리의 fiber 는
// 지난 렌더의 PerformedWork 플래그가 남아 있어, 들어가면 렌더하지 않은 것을 렌더로 센다.
const wasRecreated = (fiber: Fiber): boolean => !fiber.alternate || fiber.child !== fiber.alternate.child;

const onCommit = (root: { current: Fiber }): void => {
  if (users === 0) return;
  const now = Date.now();
  let count = 0;
  // 위에서 아래로 내려가며, 가장 가까운 렌더된 조상의 네트워크 원인을 자식에게 넘긴다.
  const visit = (fiber: Fiber | null, inherited: NetworkCause | undefined): void => {
    for (let f = fiber; f; f = f.sibling) {
      if (ignoredTypes.has(f.type)) continue;
      const rendered = isComposite(f) && (f.flags & PERFORMED_WORK) !== 0;
      const cause = rendered ? recordRender(f, now, inherited).cause : inherited;
      count += rendered ? 1 : 0;
      if (f.child && wasRecreated(f)) visit(f.child, cause);
    }
  };
  if (wasRecreated(root.current)) visit(root.current.child, undefined);
  if (count === 0) return;
  commits.push({ time: now, count });
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

/** 최근 10초 렌더가 있는 컴포넌트들(렌더 많은 순) */
export const getTopRenders = (limit = 20, now = Date.now()): Array<RenderEntry & RenderSummary> =>
  Array.from(active, (e) => Object.assign(summarize(e, now), e))
    .filter((e) => e.recent > 0)
    .toSorted((a, b) => b.recent - a.recent)
    .slice(0, limit);
