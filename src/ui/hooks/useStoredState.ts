import { useCallback, useState } from 'react';

import { readStored, writeStored } from '../../shared/storage.js';

type Update<T> = T | ((prev: T) => T);

// 기본 직렬화. 렌더마다 새 함수가 생기지 않도록 모듈에 둔다.
const asIs = <T>(value: T): unknown => value;

/**
 * localStorage 에 기억하는 state. 값을 바꿀 때 함께 저장한다(effect 를 거치지 않는다).
 * 사용자 동작마다 한 번씩 바꾸는 설정용이라, 렌더 사이에 여러 번 바꿔도 마지막 값이 저장된다.
 */
export const useStoredState = <T>(
  key: string,
  parse: (raw: unknown) => T | undefined,
  fallback: () => T,
  serialize: (value: T) => unknown = asIs,
) => {
  const [value, setValue] = useState<T>(() => readStored(key, parse, fallback()));
  const update = useCallback(
    (next: Update<T>) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
      setValue(resolved);
      writeStored(key, serialize(resolved));
    },
    [key, value, serialize],
  );
  return [value, update] as const;
};
