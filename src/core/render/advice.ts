import { endpointOf } from '../requests/requestKey.js';
import type { RenderGroup } from './groups.js';
import type { NetworkCauseCount, StateHookSummary } from './types.js';

const propsList = (keys: readonly string[]): string => keys.map((k) => `props.${k}`).join(', ');

// 시작점 조언을 낼 만큼 하위가 헛렌더됐는지: 값이 그대로인 하위 컴포넌트가 이만큼 이상이고,
const MIN_UNCHANGED_COMPONENTS = 2;
// 값이 바뀐 props 는 이만큼 이하(바뀌는 값이 좁은 곳에서만 쓰인다)
const MAX_CHANGED_PROPS = 3;
const MS_PER_SECOND = 1000;

const seconds = (ms: number): string => `${(ms / MS_PER_SECOND).toFixed(1)}s`;

const hookText = (h: StateHookSummary): string => `${h.label}${h.intervalMs ? `, every ${seconds(h.intervalMs)}` : ''}`;

/** 이 컴포넌트가 시작한 렌더 대부분이 값이 그대로인 하위의 헛렌더면, 바뀌는 state 를 쓰는 곳 가까이로 내리라고 한다. */
export const colocationAdvice = (g: RenderGroup): string | undefined => {
  const impact = g.impact;
  if (!impact || impact.unchangedComponents < MIN_UNCHANGED_COMPONENTS || impact.changedProps.length > MAX_CHANGED_PROPS) return undefined;
  if (impact.unchanged * 2 < impact.renders) return undefined;
  const cause = g.stateHooks[0] ? `state(${hookText(g.stateHooks[0])})` : 'state·context';
  const changed =
    impact.changedProps.length > 0 ? `only ${impact.changedProps.join(' → ')} actually changed` : 'no value changed in child components';
  return `A ${cause} change in this component triggered ${impact.renders} child renders, but ${changed} (${impact.unchangedComponents} components had unchanged values). Moving the changing value closer to the components that use it (state colocation) eliminates ${impact.unchanged} of those renders — a more fundamental fix than adding React.memo one by one.`;
};

// 응답 직후 자기 state 가 이만큼 넘게 바뀌고, 그 요청이 effect 에서 나가면 고리로 본다.
const LOOP_MIN_RENDERS = 5;
// 요청을 보낸 코드에서 이름만 뽑아 보여 줄 프레임 수
const CALLER_FRAMES = 2;

/** 요청을 보낸 코드의 위쪽 함수 이름들: "fetchActiveNotices ← useNoticePopup[useEffect()]" */
const callerNames = (stack: string | undefined): string =>
  (stack ?? '')
    .split('\n')
    .slice(0, CALLER_FRAMES)
    .map((line) => /^at (\S+)/.exec(line.trim())?.[1])
    .filter(Boolean)
    .join(' ← ');

// 요청이 effect 안에서 나갔다는 표시: React 19 dev 의 훅 프레임 이름("useX[useEffect()]")과, 18·19 의 effect 실행 함수
const FROM_EFFECT = /\[use(?:Layout|Insertion)?Effect\(\)\]|commitHookEffectListMount/;

const isLoop = (c: NetworkCauseCount): boolean => c.direct + c.timing >= LOOP_MIN_RENDERS && FROM_EFFECT.test(c.record.stack ?? '');

/** 응답을 받을 때마다 자기 state 가 바뀌고, 그 요청이 effect 안에서 다시 나가면 의존성 고리를 의심하라고 한다. */
const loopAdvice = (g: RenderGroup): string | undefined => {
  const loop = g.causes.find(isLoop);
  if (!loop) return undefined;
  const caller = callerNames(loop.record.stack);
  return `Every response from ${endpointOf(loop.record)} changes this component's state and triggers a render (×${loop.direct + loop.timing}), and the request is re-issued from an effect${caller ? ` (${caller})` : ''}. This is a response → state → effect → request loop. Check whether the effect's dependency array includes state the effect changes or values re-created on every render.`;
};

/** 일정한 간격으로 바뀌는 state 는 타이머가 바꾸는 경우가 많다. */
const timerAdvice = (g: RenderGroup): string | undefined => {
  const timed = g.stateHooks.find((h) => h.intervalMs);
  return timed?.intervalMs
    ? `${timed.label} changes every ${seconds(timed.intervalMs)} (recent: ${timed.last.from} → ${timed.last.to}). Check whether a setInterval or setTimeout timer is updating this state. If only a displayed value changes, keeping the counter inside the component that shows it will reduce renders.`
    : undefined;
};

const parentAdvice = (g: RenderGroup): string | undefined => {
  if (g.reasons.parent === 0 || g.memoized) return undefined;
  const origin = g.origins[0] ? `<${g.origins[0].name}>` : 'parent';
  return g.compiled
    ? `props, state, and context are unchanged, but this component re-rendered because ${origin} did. React Compiler already memoizes this component, so React.memo will not help. Move frequently-changing values in ${origin} closer to where they are used.`
    : `props, state, and context are unchanged, but this component re-rendered because ${origin} did. Wrapping it with React.memo can prevent this. If ${origin}'s state changes often, moving that state closer to where it is used is a more fundamental fix.`;
};

/** memo 인데 한 번도 건너뛰지 못했고 렌더마다 새 참조가 내려오면, memo 가 효과 없다고 짚는다. */
const memoAdvice = (g: RenderGroup): string | undefined =>
  g.memo && g.memo.neverSkippedProps.length > 0
    ? `React.memo has no effect: ${propsList(g.memo.neverSkippedProps)} is a new reference on every render, so all ${g.memo.rendered} renders went through and none were skipped. Wrap functions in useCallback and objects in useMemo in the parent to stabilize the references.`
    : undefined;

/** 같은 자리에서 컴포넌트 타입이 바뀌어 하위 트리가 통째로 다시 마운트되면 정의 위치를 고치라고 한다. */
const typeChangedAdvice = (g: RenderGroup): string | undefined => {
  const r = g.mounts?.remounts.find((x) => x.cause === 'type-changed');
  return r
    ? `<${g.name}> remounted ×${r.count}${g.location ? ` (${g.location})` : ''} because the component type is re-created on every render. This is the most expensive waste: the entire subtree is discarded and rebuilt from scratch. Define the component at module level instead of inside a render, or reduce the useMemo dependencies that produce that definition.`
    : undefined;
};

/**
 * 줄일 수 있거나 점검할 렌더가 있으면 어떻게 줄일지 알려 준다.
 * 렌더는 네트워크와 무관하게도 비효율적일 수 있으므로 네트워크 원인과 상관없이 판단한다.
 * 시작점(바뀐 state 를 가진 컴포넌트)에 대한 조언을 먼저 둔다. 고칠 곳은 대개 거기다.
 */
export const renderAdvice = (g: RenderGroup): string[] =>
  [
    typeChangedAdvice(g),
    memoAdvice(g),
    loopAdvice(g),
    colocationAdvice(g),
    timerAdvice(g),
    g.reasons['same-content'] > 0 &&
      `${propsList(g.sameContentKeys)} has the same content but is passed as a new object on every render. Stabilize the reference with useMemo in the parent, or receive the response via structural sharing (e.g., React Query select).`,
    g.reasons['new-callback'] > 0 &&
      `${propsList(g.callbackKeys)} receives a new function on every render. Wrap it with useCallback in the parent.`,
    parentAdvice(g),
    g.reasons.context > 0 &&
      `A context value this component reads (${g.contextKeys.join(', ')}) changed. React.memo cannot prevent this. Split frequently-changing values into a separate context, or wrap the Provider's value with useMemo.`,
  ].filter((text): text is string => typeof text === 'string');
