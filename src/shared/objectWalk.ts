export const isDomNode = (value: object): boolean => typeof Node !== 'undefined' && value instanceof Node;

/**
 * 브라우저 전역 객체(window). 속성이 모두 getter 라 펼치면 지원 중단 API(fence 등)까지 읽어 콘솔 경고가 나고,
 * 저장소가 막힌 문서에서는 localStorage getter 가 예외를 던진다(#138). getter 를 읽지 않고 판정한다.
 */
const isWindow = (value: object): boolean => value === globalThis || (typeof Window !== 'undefined' && value instanceof Window);

/** 응답 데이터일 리 없는 브라우저 객체: DOM 노드, window. 펼치지도 파생 매칭 후보로 쓰지도 않는다. */
export const isHostObject = (value: object): boolean => isDomNode(value) || isWindow(value);

/** 출처를 찾을 때 따라가지 않는 값: 브라우저 객체, React element(_owner 로 끝없이 퍼진다) */
export const isOpaque = (value: object): boolean => isHostObject(value) || !!(value as { $$typeof?: unknown }).$$typeof;

/** 배열·객체의 자식들을 (이름, 값) 쌍으로. 아주 큰 컬렉션은 앞쪽만 본다. */
export const childEntries = (value: object, limit: number): Array<readonly [string, unknown]> =>
  Array.isArray(value)
    ? value.slice(0, limit).map((v, i) => [`[${i}]`, v] as const)
    : Object.entries(value)
        .slice(0, limit)
        .map(([k, v]) => [`.${k}`, v] as const);
