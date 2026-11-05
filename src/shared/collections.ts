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

/**
 * 키별로 세어 { ...첫 항목의 모양, count } 를 많은 순으로 돌려준다. 키가 undefined 인 항목은 뺀다.
 * shapeOf 는 키마다 처음 나온 항목으로 한 번만 부른다.
 */
export const countBy = <T, S extends object>(
  items: Iterable<T>,
  keyOf: (item: T) => string | undefined,
  shapeOf: (item: T) => S,
): Array<S & { count: number }> => {
  const counts = new Map<string, S & { count: number }>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined) continue;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, Object.assign(shapeOf(item), { count: 1 }));
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
};
