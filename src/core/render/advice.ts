import type { RenderGroup } from './groups.js';

const propsList = (keys: readonly string[]): string => keys.map((k) => `props.${k}`).join(', ');

/**
 * 줄일 수 있거나 점검할 렌더가 있으면 어떻게 줄일지 알려 준다.
 * 렌더는 네트워크와 무관하게도 비효율적일 수 있으므로 네트워크 원인과 상관없이 판단한다.
 */
export const renderAdvice = (g: RenderGroup): string[] =>
  [
    g.reasons['same-content'] > 0 &&
      `${propsList(g.sameContentKeys)} 가 내용은 같은데 새 객체로 내려옵니다. 부모에서 useMemo 로 참조를 유지하거나, 응답을 구조적 공유(React Query select 등)로 받으세요.`,
    g.reasons['new-callback'] > 0 && `${propsList(g.callbackKeys)} 에 렌더마다 새 함수가 내려옵니다. 부모에서 useCallback 으로 감싸세요.`,
    g.reasons.parent > 0 &&
      !g.memoized &&
      'props·state·context 가 그대로인데 부모가 렌더돼서 같이 렌더됐습니다. React.memo 로 감싸면 줄일 수 있습니다.',
    g.reasons.context > 0 &&
      `읽고 있는 context(${g.contextKeys.join(', ')}) 값이 바뀌어 렌더됐습니다. React.memo 로는 줄지 않습니다. 자주 바뀌는 값과 아닌 값을 다른 context 로 나누거나, Provider 의 value 를 useMemo 로 감싸세요.`,
  ].filter((text): text is string => typeof text === 'string');
