import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { configVersion, subscribeConfig } from '../../core/config.js';
import { IGNORE_KEY, ignoreMatcher, parseIgnored, type IgnoreMatcher } from '../../shared/ignoredEndpoints.js';
import { useStoredState } from './useStoredState.js';
const serialize = (value: ReadonlySet<string>) => Array.from(value);
const empty = () => new Set<string>() as ReadonlySet<string>;

/**
 * 낭비로 세지 않을 엔드포인트(의도된 반복). 사용자가 요청 탭에서 지정하고 다음에도 기억하며, 코드(configure)의 무시와 합친다.
 * configure 를 다시 부르면 판정을 새로 만들어 분류·요청 탭이 같은 기준으로 다시 그린다.
 */
export const useIgnoredEndpoints = (): { ignored: IgnoreMatcher; toggle: (endpoint: string) => void } => {
  const [panel, setPanel] = useStoredState(IGNORE_KEY, parseIgnored, empty, { serialize });
  const version = useSyncExternalStore(subscribeConfig, configVersion, configVersion);
  // 설정이 바뀌면 엔드포인트별로 기억한 판정을 버리고 새로 만든다.
  const ignored = useMemo(() => ignoreMatcher(panel, version), [panel, version]);
  const toggle = useCallback(
    (endpoint: string) =>
      setPanel((prev) => (prev.has(endpoint) ? new Set([...prev].filter((e) => e !== endpoint)) : new Set([...prev, endpoint]))),
    [setPanel],
  );
  return { ignored, toggle };
};
