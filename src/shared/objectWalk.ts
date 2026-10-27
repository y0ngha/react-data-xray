export const isDomNode = (value: object): boolean => typeof Node !== 'undefined' && value instanceof Node;

/** 출처를 찾을 때 따라가지 않는 값: DOM 노드, React element(_owner 로 끝없이 퍼진다) */
export const isOpaque = (value: object): boolean => isDomNode(value) || !!(value as { $$typeof?: unknown }).$$typeof;

/** 배열·객체의 자식들을 (이름, 값) 쌍으로. 아주 큰 컬렉션은 앞쪽만 본다. */
export const childEntries = (value: object, limit: number): Array<readonly [string, unknown]> =>
  Array.isArray(value)
    ? value.slice(0, limit).map((v, i) => [`[${i}]`, v] as const)
    : Object.entries(value)
        .slice(0, limit)
        .map(([k, v]) => [`.${k}`, v] as const);
