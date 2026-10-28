import { renderAdvice } from '../render/advice.js';
import { sortRenderGroups } from '../render/groups.js';
import { getCommits, getRenderGroups, MAX_GROUPED_INSTANCES, reportWindowMs } from '../render/monitor.js';
import { withHookPathsSync } from '../render/summary.js';
import { RENDER_REASONS } from '../render/types.js';
import { endpointOf } from '../requests/requestKey.js';

const MAX_RENDER_GROUPS = 30;
const MAX_HEAVIEST_COMMITS = 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface RenderSection {
  monitoring: boolean;
  /** renders.components 가 센 구간(초) */
  windowSeconds: number;
  /** 인스턴스가 너무 많아 렌더 적은 인스턴스를 센 대상에서 뺐는지와 그 수 */
  truncated: boolean;
  droppedInstances: number;
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
    'renders.components 는 renders.windowSeconds 동안(reset 했으면 그 뒤 최대 2분, 아니면 최근 10초)의 렌더를 컴포넌트 이름별로 합친 것이고, 줄일 수 있는 렌더 많은 순이다. 컴포넌트마다 최근 200회까지만 센다.',
  viaParent: 'networkCauses 의 viaParent 는 조상이 응답으로 렌더돼서 따라 렌더된 횟수다. 고칠 곳은 대개 그 조상의 setState 다.',
  byTiming: 'networkCauses 의 byTiming 은 응답 객체는 찾지 못했지만(가공해 넣음) 응답 도착 직후 자기 state 가 바뀐 횟수다(시간으로 추정).',
  sameResponse:
    'networkCauses 의 fromSameResponse 는 직전과 똑같은 응답인데도 렌더된 횟수다. 같은 응답이면 setState 를 건너뛰거나 구조적 공유를 쓴다.',
  causedBy: 'causedBy 는 그 렌더를 시작한 조상(이름·이유)이다. renderedAt 은 이 컴포넌트를 그리는 JSX 위치다.',
  stateChanges:
    'stateChanges 는 state 때문에 렌더됐을 때 값이 바뀐 훅(종류 #순서)과 횟수, 일정한 간격(intervalMs, 타이머 신호), 최근 변경이다.',
  startedRenders:
    'startedRenders 는 이 컴포넌트가 시작한 렌더가 하위에 미친 영향이다. unchanged 가 크고 changedProps 가 적으면, 바뀌는 state 를 changedProps 의 마지막 컴포넌트 가까이로 내리는 것이 해법이다(advice 첫 줄).',
};

const nonZero = (reasons: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(reasons).filter(([, n]) => n > 0));

export const buildRenderSection = (monitoring: boolean, now: number): RenderSection => {
  const windowMs = reportWindowMs(now);
  const { groups: all, truncated, droppedInstances } = getRenderGroups(now, windowMs);
  const groups = sortRenderGroups(all, 'avoidable').slice(0, MAX_RENDER_GROUPS);
  const heaviest = getCommits()
    .filter((c) => c.ms !== undefined && c.time >= now - windowMs)
    .sort((a, b) => b.ms! - a.ms!)
    .slice(0, MAX_HEAVIEST_COMMITS);
  return {
    monitoring,
    windowSeconds: Math.round(windowMs / 1000),
    truncated,
    droppedInstances,
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
};

// 새 howToRead 줄은 여기에 더한다.
export const RENDER_HOW_TO_READ_EXTRA: readonly string[] = [
  `renders.truncated 가 true 면 렌더된 인스턴스가 ${MAX_GROUPED_INSTANCES}개를 넘어 렌더 적은 인스턴스(droppedInstances 개)를 센 대상에서 뺀 것이다. 컴포넌트마다 최근 200회까지만 센다는 상한과는 별개다.`,
  "stateChanges 의 label 은 dev 빌드면 훅을 부른 커스텀 훅 경로가 앞에 붙고(예: useCart › useState #2), 소스맵이 있으면 호출 위치가 뒤에 붙는다(src/x.ts:12). 없으면 '종류 #순서' 만 나온다.",
  'components[].memo 는 React.memo 컴포넌트가 부모 렌더를 건너뛴 횟수(skipped)와 다시 렌더된 횟수(rendered, 부모 렌더가 원인인 것만. 마운트·자기 state·context 로 렌더된 것은 제외)다. skipped 가 0 이고 neverSkippedProps 가 있으면 그 props 가 렌더마다 새 참조라 memo 가 효과가 없는 것이다(advice 첫 줄).',
  'components 는 같은 이름이라도 그리는 위치(renderedAt)가 다르면 따로 센다. 라이브러리 안쪽 컴포넌트(번들에서 축약된 이름)는 그린 앱 컴포넌트의 libraries 에 패키지 이름과 함께 접혀 있다. package 가 있는 줄은 그린 앱 컴포넌트를 못 찾은 것이다.',
  'components[].time 은 구간 렌더 시간 합(totalMs)·1회 평균(avgMs)·줄일 수 있는 렌더의 합(avoidableMs)이고, startedRenders.childMs·unchangedMs 는 따라 렌더된 하위의 합과 그중 값이 그대로인 렌더의 합이다. heaviestCommits 는 구간에서 렌더 시간이 가장 큰 commit 과 그것을 시작한 컴포넌트다. 모두 selfBaseDuration(자기 렌더 시간, memo 로 건너뛴 것 제외 전 기준)의 합이고 dev 빌드 기준이라 production 보다 크다. 절대값보다 수정 전후 비교로 읽는다. 시간을 얻지 못하면 이 필드들은 없다.',
  'components[].mounts 는 언마운트가 있었던 컴포넌트의 마운트·언마운트 횟수다(reset 뒤, 이름 기준). remounts 는 같은 부모 아래에서 모두 사라졌다가 5초 안에 다시 마운트된 횟수이고 parent 는 그 서브트리를 갈아 끼운 가장 가까운 부모다. 마운트 effect 의 요청·구독·타이머가 그때마다 다시 돈다. 목록 항목처럼 형제가 남아 있으면 세지 않는다. remounts[].cause 가 type-changed 면 같은 자리에서 이름은 같고 컴포넌트 타입(함수 정체)만 바뀐 재마운트로, 렌더 중에 컴포넌트를 새로 만들 때 생기며 형제 수와 상관없이 센다.',
];
