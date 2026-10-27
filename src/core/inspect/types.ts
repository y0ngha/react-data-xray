import type { RequestRecord } from '../requests/types.js';

/** exact: 같은 참조 · derived: 가공된 객체지만 필드 값이 응답 객체와 일치 · text: 화면 글자만 일치 */
export type MatchKind = 'exact' | 'derived' | 'text';

export interface Hit {
  record: RequestRecord;
  /** 응답 본문 안의 위치. 예: $.data.list[3].title */
  path: string;
  /** 컴포넌트 안에서 값이 있던 곳. 예: props.row, hook[2] */
  via: string;
  queryKey?: unknown;
  match: MatchKind;
}

export interface ComponentResult {
  /** 클릭한 요소에서 몇 번째 조상 컴포넌트인지(화면 key) */
  depth: number;
  name: string;
  hits: Hit[];
}

export interface InspectResult {
  components: ComponentResult[];
  guesses: Hit[];
}

/** 전체 표시에 그릴 박스: 응답 객체를 props 로 받는 컴포넌트 */
export interface Box {
  /** 트리 탐색 순번(화면 key) */
  id: number;
  rect: DOMRect;
  name: string;
  hit: Hit;
  /** 렌더 횟수를 찾을 때 쓰는 컴포넌트 fiber */
  fiber: unknown;
}

/** 요청의 응답 데이터를 쓰는 컴포넌트 */
export interface Consumer {
  /** 트리 탐색 순번(화면 key) */
  id: number;
  name: string;
  rect: DOMRect | null;
  /** 컴포넌트 안에서 데이터가 있던 곳. 예: props.item, useQuery */
  via: string;
}
