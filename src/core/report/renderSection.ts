import { renderAdvice } from '../render/advice.js';
import { sortRenderGroups } from '../render/groups.js';
import { getRenderGroups, reportWindowMs } from '../render/monitor.js';
import { RENDER_REASONS } from '../render/types.js';
import { endpointOf } from '../requests/requestKey.js';

const MAX_RENDER_GROUPS = 30;

export interface RenderSection {
  monitoring: boolean;
  /** renders.components 가 센 구간(초) */
  windowSeconds: number;
  /** 인스턴스가 너무 많아 렌더 적은 인스턴스를 센 대상에서 뺐는지와 그 수 */
  truncated: boolean;
  droppedInstances: number;
  components: Array<{
    name: string;
    instances: number;
    renders: number;
    avoidable: number;
    memoized: boolean;
    /** React.memo 컴포넌트가 부모 렌더를 건너뛴 횟수와 다시 렌더된 횟수(마운트 제외) */
    memo?: { skipped: number; rendered: number; neverSkippedProps: string[] };
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
  return {
    monitoring,
    windowSeconds: Math.round(windowMs / 1000),
    truncated,
    droppedInstances,
    components: groups.map((g) => ({
      name: g.name,
      instances: g.instances,
      renders: g.recent,
      avoidable: g.avoidable,
      memoized: g.memoized,
      memo: g.memo,
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
      stateChanges: g.stateHooks,
      startedRenders: g.impact,
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
  'renders.truncated 가 true 면 렌더된 인스턴스가 5000개를 넘어 렌더 적은 인스턴스(droppedInstances 개)를 센 대상에서 뺀 것이다. 컴포넌트마다 최근 200회까지만 센다는 상한과는 별개다.',
  "stateChanges 의 label 은 dev 빌드면 훅을 부른 커스텀 훅 경로가 앞에 붙고(예: useCart › useState #2), 소스맵이 있으면 호출 위치가 뒤에 붙는다(src/x.ts:12). 없으면 '종류 #순서' 만 나온다.",
  'components[].memo 는 React.memo 컴포넌트가 부모 렌더를 건너뛴 횟수(skipped)와 다시 렌더된 횟수(rendered, 마운트 제외)다. skipped 가 0 이고 neverSkippedProps 가 있으면 그 props 가 렌더마다 새 참조라 memo 가 효과가 없는 것이다(advice 첫 줄).',
  'components 는 같은 이름이라도 그리는 위치(renderedAt)가 다르면 따로 센다. 라이브러리 안쪽 컴포넌트(번들에서 축약된 이름)는 그린 앱 컴포넌트의 libraries 에 패키지 이름과 함께 접혀 있다. package 가 있는 줄은 그린 앱 컴포넌트를 못 찾은 것이다.',
];
