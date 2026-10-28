import { endpointOf } from '../requests/requestKey.js';
import type { RenderGroup } from './groups.js';
import type { NetworkCauseCount, StateHookSummary } from './types.js';

const propsList = (keys: readonly string[]): string => keys.map((k) => `props.${k}`).join(', ');

// 시작점 조언을 낼 만큼 하위가 헛렌더됐는지: 값이 그대로인 하위 컴포넌트가 이만큼 이상이고,
const MIN_UNCHANGED_COMPONENTS = 2;
// 값이 바뀐 props 는 이만큼 이하(바뀌는 값이 좁은 곳에서만 쓰인다)
const MAX_CHANGED_PROPS = 3;
const MS_PER_SECOND = 1000;

const seconds = (ms: number): string => `${(ms / MS_PER_SECOND).toFixed(1)}초`;

const hookText = (h: StateHookSummary): string => `${h.label}${h.intervalMs ? `, ${seconds(h.intervalMs)}마다` : ''}`;

/** 이 컴포넌트가 시작한 렌더 대부분이 값이 그대로인 하위의 헛렌더면, 바뀌는 state 를 쓰는 곳 가까이로 내리라고 한다. */
export const colocationAdvice = (g: RenderGroup): string | undefined => {
  const impact = g.impact;
  if (!impact || impact.unchangedComponents < MIN_UNCHANGED_COMPONENTS || impact.changedProps.length > MAX_CHANGED_PROPS) return undefined;
  if (impact.unchanged * 2 < impact.renders) return undefined;
  const cause = g.stateHooks[0] ? `state(${hookText(g.stateHooks[0])})` : 'state·context';
  const changed =
    impact.changedProps.length > 0 ? `값이 실제로 바뀐 건 ${impact.changedProps.join(' → ')} 뿐입니다` : '하위에서 값이 바뀐 곳은 없습니다';
  return `이 컴포넌트의 ${cause} 변경이 하위 렌더 ${impact.renders}회를 일으켰지만, ${changed}(나머지 ${impact.unchangedComponents}개 컴포넌트는 값이 그대로). 바뀌는 값을 그것을 쓰는 컴포넌트 가까이로 내리면(state colocation) ${impact.unchanged}회가 사라집니다. React.memo 를 하나씩 붙이는 것보다 근본적인 해법입니다.`;
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
  return `${endpointOf(loop.record)} 응답을 받을 때마다 이 컴포넌트의 state 가 바뀌어 렌더되고(${loop.direct + loop.timing}회), 그 요청은 effect 안에서 다시 나갑니다${caller ? `(${caller})` : ''}. 응답 → state → effect → 다시 요청 고리입니다. 그 effect 의 의존성 배열에 effect 가 바꾸는 state 나 렌더마다 새로 만드는 값이 들어 있는지 보세요.`;
};

/** 일정한 간격으로 바뀌는 state 는 타이머가 바꾸는 경우가 많다. */
const timerAdvice = (g: RenderGroup): string | undefined => {
  const timed = g.stateHooks.find((h) => h.intervalMs);
  return timed?.intervalMs
    ? `${timed.label} 이(가) ${seconds(timed.intervalMs)}마다 바뀝니다(최근 ${timed.last.from} → ${timed.last.to}). setInterval·setTimeout 같은 타이머가 이 state 를 바꾸는지 보세요. 화면에 보이는 값만 바뀐다면 그 값을 쓰는 컴포넌트 안에서 세는 편이 렌더를 줄입니다.`
    : undefined;
};

const parentAdvice = (g: RenderGroup): string | undefined => {
  if (g.reasons.parent === 0 || g.memoized) return undefined;
  const origin = g.origins[0] ? `<${g.origins[0].name}>` : '부모';
  return g.compiled
    ? `props·state·context 가 그대로인데 ${origin} 를 따라 렌더됐습니다. React Compiler 가 이미 메모하는 컴포넌트라 React.memo 로는 줄지 않습니다. ${origin} 에서 자주 바뀌는 값을 그것을 쓰는 곳으로 내리세요.`
    : `props·state·context 가 그대로인데 ${origin} 를 따라 렌더됐습니다. React.memo 로 감싸면 줄일 수 있습니다. ${origin} 의 state 가 자주 바뀐다면 그 state 를 쓰는 곳으로 내리는 편이 더 근본적입니다.`;
};

/** memo 인데 한 번도 건너뛰지 못했고 렌더마다 새 참조가 내려오면, memo 가 효과 없다고 짚는다. */
const memoAdvice = (g: RenderGroup): string | undefined =>
  g.memo && g.memo.neverSkippedProps.length > 0
    ? `React.memo 가 효과 없습니다: ${propsList(g.memo.neverSkippedProps)} 가 렌더마다 새 참조라 ${g.memo.rendered}번 모두 다시 렌더됐고 한 번도 건너뛰지 못했습니다. 함수는 부모에서 useCallback, 객체는 useMemo 로 참조를 유지하세요.`
    : undefined;

/** 같은 자리에서 컴포넌트 타입이 바뀌어 하위 트리가 통째로 다시 마운트되면 정의 위치를 고치라고 한다. */
const typeChangedAdvice = (g: RenderGroup): string | undefined => {
  const r = g.mounts?.remounts.find((x) => x.cause === 'type-changed');
  return r
    ? `<${g.name}> 이(가) ${r.count}회 재마운트됐는데 컴포넌트 타입이 렌더마다 새로 만들어집니다${g.location ? `(${g.location})` : ''}. 하위 트리 전체가 버려지고 다시 만들어지는 가장 비싼 낭비입니다. 렌더 중에 컴포넌트를 정의하지 말고 모듈 수준에 두거나, 그 정의를 만드는 useMemo 의 의존성을 줄이세요.`
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
      `${propsList(g.sameContentKeys)} 가 내용은 같은데 새 객체로 내려옵니다. 부모에서 useMemo 로 참조를 유지하거나, 응답을 구조적 공유(React Query select 등)로 받으세요.`,
    g.reasons['new-callback'] > 0 && `${propsList(g.callbackKeys)} 에 렌더마다 새 함수가 내려옵니다. 부모에서 useCallback 으로 감싸세요.`,
    parentAdvice(g),
    g.reasons.context > 0 &&
      `읽고 있는 context(${g.contextKeys.join(', ')}) 값이 바뀌어 렌더됐습니다. React.memo 로는 줄지 않습니다. 자주 바뀌는 값과 아닌 값을 다른 context 로 나누거나, Provider 의 value 를 useMemo 로 감싸세요.`,
  ].filter((text): text is string => typeof text === 'string');
