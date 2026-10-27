import { useCallback } from 'react';

import { IGNORE_KEY, parseIgnored } from '../../shared/ignoredEndpoints.js';
import { useStoredState } from './useStoredState.js';
const serialize = (value: ReadonlySet<string>) => Array.from(value);
const empty = () => new Set<string>() as ReadonlySet<string>;

/** 낭비로 세지 않을 엔드포인트(의도된 반복). 사용자가 요청 탭에서 지정하고, 다음에도 기억한다. */
export const useIgnoredEndpoints = () => {
  const [ignored, setIgnored] = useStoredState(IGNORE_KEY, parseIgnored, empty, serialize);
  const toggle = useCallback(
    (endpoint: string) =>
      setIgnored((prev) => (prev.has(endpoint) ? new Set([...prev].filter((e) => e !== endpoint)) : new Set([...prev, endpoint]))),
    [setIgnored],
  );
  return { ignored, toggle };
};
