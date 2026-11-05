import { renderAdvice } from '../render/advice.js';
import { sortRenderGroups, type RenderGroup } from '../render/groups.js';
import { getCommits, getRenderGroups, MAX_GROUPED_INSTANCES, reportWindowMs } from '../render/monitor.js';
import { withHookPathsSync } from '../render/summary.js';
import { RENDER_REASONS } from '../render/types.js';
import { endpointOf } from '../requests/requestKey.js';

export const MAX_RENDER_GROUPS = 30;
/** compare 용으로 남기는 렌더 행의 상한(보고서 행 포함). 스냅샷 6개를 sessionStorage 에 두므로 행 수를 묶는다 */
export const MAX_COMPARABLE_RENDER_ROWS = 200;
const MAX_HEAVIEST_COMMITS = 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface RenderSection {
  monitoring: boolean;
  /** renders.components 가 센 구간(초) */
  windowSeconds: number;
  /** 인스턴스가 너무 많아 렌더 적은 인스턴스를 센 대상에서 뺐는지와 그 수 */
  truncated: boolean;
  droppedInstances: number;
  /**
   * components 상한(MAX_RENDER_GROUPS 행) 밖으로 빠진 컴포넌트 행 수와 그 행들의 렌더·줄일 수 있는 렌더·렌더 시간 합.
   * 빠진 행이 없으면 모두 0 이다. compare 는 이 값으로 합계를 맞추고, 상한 때문에 빠진 행을 사라진 것으로 보지 않는다
   */
  omitted: { components: number; renders: number; avoidable: number; totalMs?: number };
  /** 구간 안에서 렌더 시간이 가장 큰 commit 몇 개(시간 기록이 있을 때만) */
  heaviestCommits?: Array<{ ms: number; components: number; startedBy?: string; secondsAgo: number }>;
  components: Array<{
    name: string;
    instances: number;
    renders: number;
    avoidable: number;
    /** 구간 렌더 시간 합·1회 평균·줄일 수 있는 렌더의 합(ms, selfBaseDuration 기준). dev 빌드가 시간을 주지 않으면 없다 */
    time?: { totalMs: number; avgMs: number; avoidableMs: number };
    memoized: boolean;
    /** React.memo 컴포넌트가 부모 렌더를 건너뛴 횟수와 다시 렌더된 횟수(부모 렌더가 원인인 것만) */
    memo?: { skipped: number; rendered: number; neverSkippedProps: string[] };
    /** 마운트·언마운트 횟수와, 같은 자리에서 곧 다시 마운트된 재마운트(그 서브트리를 갈아 끼운 부모별). 언마운트가 있었을 때만 */
    mounts?: { mounts: number; unmounts: number; remounts: Array<{ parent: string; count: number; cause?: 'type-changed' }> };
    reasons: Record<string, number>;
    changedProps: {
      sameContent: string[];
      newCallback: string[];
      context: string[];
    };
    /** 이 컴포넌트를 그리는 JSX 위치(dev 빌드가 기록할 때) */
    renderedAt?: string;
    /** 라이브러리 소유 컴포넌트를 그릴 앱 컴포넌트를 못 찾아 따로 남았을 때의 패키지 이름 */
    package?: string;
    /** 이 컴포넌트가 그려서 안쪽에서 렌더된 라이브러리 컴포넌트(패키지별) */
    libraries?: Array<{ package: string; name: string; instances: number; renders: number; avoidable: number }>;
    /** 조상 때문에 렌더됐다면 그 렌더를 시작한 조상(이름·이유). 고칠 곳은 대개 이 조상이다 */
    causedBy: Array<{ name: string; reason: string; count: number }>;
    stateChanges: Array<{
      label: string;
      count: number;
      intervalMs?: number;
      last: { from: string; to: string };
    }>;
    startedRenders?: {
      renders: number;
      unchanged: number;
      unchangedComponents: number;
      changedProps: string[];
      /** 따라 렌더된 하위의 렌더 시간 합과 그중 값이 그대로인 렌더의 합(ms) */
      childMs?: number;
      unchangedMs?: number;
    };
    networkCauses: Array<{
      endpoint: string;
      direct: number;
      byTiming: number;
      viaParent: number;
      fromSameResponse: number;
    }>;
    advice: string[];
  }>;
}

/** 순서는 buildReport 가 다른 섹션 줄과 맞춘다. */
export const RENDER_HOW_TO_READ = {
  window:
    'renders.components aggregates renders during renders.windowSeconds (up to 2 minutes after a reset, otherwise the last 10s), sorted by most avoidable renders. At most 200 renders per component are counted.',
  viaParent:
    "networkCauses.viaParent is the number of times this component re-rendered because an ancestor rendered due to a network response. The fix is usually that ancestor's setState.",
  byTiming:
    "networkCauses.byTiming is the number of times this component's own state changed immediately after a response arrived (detected by timing, not by response object — the response was likely transformed before being stored).",
  sameResponse:
    'networkCauses.fromSameResponse is the number of renders triggered by a response identical to the previous one. Skip setState or use structural sharing when the response has not changed.',
  causedBy:
    'causedBy is the ancestor that started the render (name and reason). renderedAt is the JSX location that renders this component.',
  stateChanges:
    'stateChanges lists the hooks (type #index) whose value changed when a state render occurred, along with the count, a regular interval (intervalMs, a timer signal), and the most recent change.',
  startedRenders:
    'startedRenders shows the impact of renders this component started on its children. When unchanged is large and changedProps is small, moving the changing state closer to the last component in changedProps is the fix (see the first line of advice).',
};

const nonZero = (reasons: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(reasons).filter(([, n]) => n > 0));

/** compare 가 행을 맞춰 보는 데 쓰는 값만 담은 렌더 행 */
export interface RenderRowTally {
  name: string;
  renders: number;
  avoidable: number;
  renderedAt?: string;
  package?: string;
  totalMs?: number;
}

const timeOf = (g: RenderGroup): number | undefined => ((g.timed ?? 0) > 0 ? round1(g.ms) : undefined);

const tallyOf = (g: RenderGroup): RenderRowTally => ({
  name: g.name,
  renders: g.recent,
  avoidable: g.avoidable,
  renderedAt: g.location,
  package: g.package,
  totalMs: timeOf(g),
});

// 보고서 상한 밖 행(compare 용). 보고서 JSON 에는 싣지 않고, 같은 섹션 객체로 toComparable 이 꺼내 스냅샷에만 남긴다.
const rowsBeyondCap = new WeakMap<RenderSection, RenderRowTally[]>();

/** 이 섹션을 만들 때 상한 밖으로 빠진 행(많아야 MAX_COMPARABLE_RENDER_ROWS - 보고서 행 수). 파일에서 읽은 보고서면 없다 */
export const rowsBeyondCapOf = (section: RenderSection): readonly RenderRowTally[] | undefined => rowsBeyondCap.get(section);

const omittedOf = (rest: readonly RenderGroup[]): RenderSection['omitted'] => {
  const timed = rest.map(timeOf).filter((ms): ms is number => ms !== undefined);
  return {
    components: rest.length,
    renders: rest.reduce((n, g) => n + g.recent, 0),
    avoidable: rest.reduce((n, g) => n + g.avoidable, 0),
    ...(timed.length > 0 && { totalMs: round1(timed.reduce((n, ms) => n + ms, 0)) }),
  };
};

export const buildRenderSection = (monitoring: boolean, now: number): RenderSection => {
  const windowMs = reportWindowMs(now);
  const { groups: all, truncated, droppedInstances } = getRenderGroups(now, windowMs);
  const sorted = sortRenderGroups(all, 'avoidable');
  const groups = sorted.slice(0, MAX_RENDER_GROUPS);
  const rest = sorted.slice(MAX_RENDER_GROUPS);
  const heaviest = getCommits()
    .filter((c) => c.ms !== undefined && c.time >= now - windowMs)
    .sort((a, b) => b.ms! - a.ms!)
    .slice(0, MAX_HEAVIEST_COMMITS);
  const section: RenderSection = {
    monitoring,
    windowSeconds: Math.round(windowMs / 1000),
    truncated,
    droppedInstances,
    omitted: omittedOf(rest),
    ...(heaviest.length > 0 && {
      heaviestCommits: heaviest.map((c) => ({
        ms: round1(c.ms!),
        components: c.count,
        startedBy: c.startedBy,
        secondsAgo: Math.round((now - c.time) / 1000),
      })),
    }),
    components: groups.map((g) => ({
      name: g.name,
      instances: g.instances,
      renders: g.recent,
      avoidable: g.avoidable,
      time:
        (g.timed ?? 0) > 0 ? { totalMs: round1(g.ms), avgMs: round1(g.ms / g.timed!), avoidableMs: round1(g.avoidableMs ?? 0) } : undefined,
      memoized: g.memoized,
      memo: g.memo,
      mounts: g.mounts,
      reasons: nonZero(Object.fromEntries(RENDER_REASONS.map((r) => [r, g.reasons[r]]))),
      changedProps: {
        sameContent: g.sameContentKeys,
        newCallback: g.callbackKeys,
        context: g.contextKeys,
      },
      renderedAt: g.location,
      package: g.package,
      libraries: g.libraries,
      causedBy: g.origins,
      // hookIndex 는 label 을 만드는 내부 값이라 보고서에 싣지 않는다.
      stateChanges: withHookPathsSync(g.stateHooks, g.fiber).map(({ label, count, intervalMs, last }) => ({
        label,
        count,
        intervalMs,
        last,
      })),
      startedRenders: g.impact && {
        ...g.impact,
        ...(g.impact.childMs !== undefined && { childMs: round1(g.impact.childMs), unchangedMs: round1(g.impact.unchangedMs ?? 0) }),
      },
      networkCauses: g.causes.map((c) => ({
        endpoint: endpointOf(c.record),
        direct: c.direct,
        byTiming: c.timing,
        viaParent: c.parent,
        fromSameResponse: c.sameResponse,
      })),
      advice: renderAdvice(g),
    })),
  };
  rowsBeyondCap.set(section, rest.slice(0, MAX_COMPARABLE_RENDER_ROWS - MAX_RENDER_GROUPS).map(tallyOf));
  return section;
};

// 새 howToRead 줄은 여기에 더한다.
export const RENDER_HOW_TO_READ_EXTRA: readonly string[] = [
  `When renders.truncated is true, the number of rendered instances exceeded ${MAX_GROUPED_INSTANCES} and the instances with fewer renders (droppedInstances of them) were excluded. This is separate from the per-component limit of 200 renders.`,
  "stateChanges.label: in a dev build, the custom hook path that called the hook is prepended (e.g., useCart › useState #2); if a source map is resolved, the call location is appended (src/x.ts:12). Without either, only 'type #index' is shown.",
  'components[].memo: skipped is the number of times a React.memo component skipped a parent render; rendered is the count where it did not skip (parent renders only — mounts, own state, and context renders are excluded). When skipped is 0 and neverSkippedProps is non-empty, those props are a new reference on every render so memo has no effect (see first line of advice).',
  'components entries with the same name but different renderedAt values are counted separately. Library-internal components (minified names in the bundle) are folded into the libraries field of the app component that renders them, along with the package name. A row with package present means no rendering app component was found.',
  'components[].time: totalMs is the total render time for the window, avgMs is the per-render average, and avoidableMs is the sum for avoidable renders. startedRenders.childMs and unchangedMs are the total and unchanged-value portions of child render time. heaviestCommits lists the most expensive commits in the window and the component that started them. All values are sums of selfBaseDuration (self render time, before memo skips) measured in a dev build and will be larger than in production. Read them comparatively (before vs. after a fix) rather than as absolute values. These fields are absent when timing is unavailable.',
  `renders.components lists at most ${MAX_RENDER_GROUPS} components (most avoidable first). renders.omitted counts the components left out by that limit and sums their renders, avoidable renders, and totalMs, so components plus omitted is the whole window. compare() keeps more rows than the report for this reason; a row it cannot see on one side is shown as status unknown, not removed.`,
  'components[].mounts: mount and unmount counts since the last reset (by component name, only when unmounts occurred). remounts counts instances that disappeared and reappeared under the same parent within 5s; parent is the nearest ancestor that swapped the subtree. Mount-effect requests, subscriptions, and timers run again each time. Siblings still present are not counted. When remounts[].cause is type-changed, the component name is the same but the function identity changed — caused by defining a component inside a render, counted regardless of sibling count.',
];
