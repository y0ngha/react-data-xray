import type { RenderGroup } from './groups.js';
import type { StateHookSummary } from './types.js';

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

/**
 * 줄일 수 있거나 점검할 렌더가 있으면 어떻게 줄일지 알려 준다.
 * 렌더는 네트워크와 무관하게도 비효율적일 수 있으므로 네트워크 원인과 상관없이 판단한다.
 * 시작점(바뀐 state 를 가진 컴포넌트)에 대한 조언을 먼저 둔다. 고칠 곳은 대개 거기다.
 */
export const renderAdvice = (g: RenderGroup): string[] =>
  [
    colocationAdvice(g),
    timerAdvice(g),
    g.reasons['same-content'] > 0 &&
      `${propsList(g.sameContentKeys)} 가 내용은 같은데 새 객체로 내려옵니다. 부모에서 useMemo 로 참조를 유지하거나, 응답을 구조적 공유(React Query select 등)로 받으세요.`,
    g.reasons['new-callback'] > 0 && `${propsList(g.callbackKeys)} 에 렌더마다 새 함수가 내려옵니다. 부모에서 useCallback 으로 감싸세요.`,
    parentAdvice(g),
    g.reasons.context > 0 &&
      `읽고 있는 context(${g.contextKeys.join(', ')}) 값이 바뀌어 렌더됐습니다. React.memo 로는 줄지 않습니다. 자주 바뀌는 값과 아닌 값을 다른 context 로 나누거나, Provider 의 value 를 useMemo 로 감싸세요.`,
  ].filter((text): text is string => typeof text === 'string');
