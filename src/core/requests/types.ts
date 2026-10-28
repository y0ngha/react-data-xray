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
  /**
   * Next.js Server Action id(`Next-Action` 헤더). Server Action 은 모두 페이지 경로로 POST 하므로, 이 값이 없으면
   * 같은 페이지의 서로 다른 함수 호출이 한 엔드포인트·같은 요청으로 묶여 중복으로 잘못 세진다.
   */
  action?: string;
  responseHeaders?: Record<string, string>;
  /** 응답 원문(텍스트 응답만, 최대 100KB). 상세 화면에서 보여 준다. */
  responseText?: string;
  /** 네트워크 실패·취소·타임아웃 */
  error?: string;
  /** 창 포커스·탭 표시 전환, 네트워크 재연결 직후에 나간 요청(라이브러리의 자동 재요청) */
  trigger?: 'focus' | 'reconnect';
  /** 요청을 보낸 코드의 호출 스택(rdx 자신의 프레임은 뺀다) */
  stack?: string;
  /** 요청을 보낸 시점의 location.pathname(쿼리 제외). 새로고침 전 기록이나 SSR 에서는 없을 수 있다. */
  route?: string;
  /** 호출 스택으로 짐작한 보낸 컴포넌트 이름. 판정할 수 없으면 없다. */
  component?: string;
  /** 호출 스택에 앱 프레임이 없다(ky 의 타이머처럼 비동기 경계에서 스택이 끊김). 보낸 위치를 모른다. */
  noAppFrame?: boolean;
  /** stack 을 소스맵으로 원본 위치로 바꾼 것(비동기로 채운다. 못 바꾸면 없다) */
  sourceStack?: string;
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
  /** 새로고침 전 페이지에서 기록해 되살린 요청. 응답 객체(body)는 없고 원문만 있다. */
  restored?: boolean;
  /** 같은 탭에서 몇 번째로 연 페이지의 요청인지. 주기 판정은 같은 페이지 안에서만 한다(새로고침 사이 간격은 주기가 아니다). */
  load?: number;
}

/** 응답 본문 안의 객체가 어느 요청의 어느 위치에서 왔는지 */
export interface Origin {
  record: RequestRecord;
  path: string;
}
