export interface RequestRecord {
  id: number;
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  /** 요청 본문(payload)을 비교할 수 있게 문자열로 바꾼 것. 없으면 undefined */
  requestBody?: string;
  /** Blob·스트림처럼 본문을 바로 읽을 수 없어 중복·같은 응답 판정에서 뺀 요청 */
  bodyUnreadable?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** 응답 원문(텍스트 응답만, 최대 100KB). 상세 화면에서 보여 준다. */
  responseText?: string;
  /** 네트워크 실패·취소·타임아웃 */
  error?: string;
  /** 창 포커스·탭 표시 전환, 네트워크 재연결 직후에 나간 요청(라이브러리의 자동 재요청) */
  trigger?: 'focus' | 'reconnect';
  /** 요청을 보낸 코드의 호출 스택(rdx 자신의 프레임은 뺀다) */
  stack?: string;
  /** React 가 StrictMode 에서 effect 를 다시 실행하는 도중에 보낸 요청(호출 스택으로 확인) */
  strictModeReplay?: boolean;
  status: number;
  startedAt: number;
  durationMs: number;
  body: unknown;
  /** 2초 안에 같은 메서드·URL·본문으로 나간 앞선 요청 */
  duplicateOf?: number;
  /** 같은 요청(메서드·URL·본문)의 직전 응답과 본문이 똑같았던 경우 */
  sameResponseAs?: number;
}

/** 응답 본문 안의 객체가 어느 요청의 어느 위치에서 왔는지 */
export interface Origin {
  record: RequestRecord;
  path: string;
}
