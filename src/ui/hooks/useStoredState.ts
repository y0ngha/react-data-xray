import { useCallback, useRef, useState } from 'react';

import { readStored, writeStored, type StorageArea } from '../../shared/storage.js';

type Update<T> = T | ((prev: T) => T);

// 기본 직렬화. 렌더마다 새 함수가 생기지 않도록 모듈에 둔다.
const asIs = <T>(value: T): unknown => value;

/**
 * 브라우저 저장소(기본 localStorage, area 로 sessionStorage)에 기억하는 state.
 * - set: 값을 바꾸고 저장한다. 함수로 넘기면 렌더를 기다리지 않은 최신 값을 받는다(연달아 불러도 앞의 변경을 잃지 않는다).
 * - set(next, { persist: false }) 후 save(): 끌기처럼 값이 계속 바뀌는 동안에는 저장을 미루고, 끝날 때 한 번만 저장한다.
 */
export const useStoredState = <T>(
  key: string,
  parse: (raw: unknown) => T | undefined,
  fallback: () => T,
  serialize: (value: T) => unknown = asIs,
  area: StorageArea = 'local',
) => {
  const [value, setValue] = useState<T>(() => readStored(key, parse, fallback(), area));
  const latest = useRef(value);

  const save = useCallback(() => writeStored(key, serialize(latest.current), area), [key, serialize, area]);

  const set = useCallback(
    (next: Update<T>, { persist = true }: { persist?: boolean } = {}) => {
      latest.current = typeof next === 'function' ? (next as (prev: T) => T)(latest.current) : next;
      setValue(latest.current);
      if (persist) save();
    },
    [save],
  );

  return [value, set, save] as const;
};
