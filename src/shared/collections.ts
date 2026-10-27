/** 키별로 묶는다(입력 순서 유지). Map.groupBy(ES2024) 를 쓰지 않는 환경을 위해 둔다. */
export const groupBy = <T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
};
