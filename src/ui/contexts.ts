import { createContext, useContext } from 'react';

import type { RequestClass } from '../core/requests/classify.js';
import type { RequestRecord } from '../core/requests/types.js';

/** 검사 결과에서 연 요청 상세: 컴포넌트가 실제로 쓰는 응답 위치 */
export interface Focus {
  path: string;
  via: string;
}

export interface RequestActions {
  /** 요청 상세를 연다. */
  open: (record: RequestRecord, focus?: Focus) => void;
  /** 요청에 호버하면 그 응답 데이터를 쓰는 컴포넌트를 강조한다. null 이면 강조를 끈다. */
  hover: (record: RequestRecord | null) => void;
  /** 요청 분류(낭비·확인 필요·정상). 화면 전체가 같은 기준을 쓴다. */
  classOf: (record: RequestRecord) => RequestClass;
}

const RequestActionsContext = createContext<RequestActions>({
  open: () => undefined,
  hover: () => undefined,
  classOf: () => 'ok',
});

export const RequestActionsProvider = RequestActionsContext.Provider;

export const useRequestActions = (): RequestActions => useContext(RequestActionsContext);
