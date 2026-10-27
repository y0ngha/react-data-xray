import { interceptFetch } from './fetchInterceptor.js';
import { interceptJsonParse } from './jsonParseInterceptor.js';
import { trackRefetchTriggers } from './requestContext.js';
import { interceptXhr } from './xhrInterceptor.js';

let installed = false;
let nativeFetch: typeof fetch | undefined;

/** 가로채기 전의 fetch. rdx 가 스스로 보내는 요청이 기록에 섞이지 않게 쓴다. */
export const getNativeFetch = (): typeof fetch => nativeFetch ?? window.fetch;

/** 요청 가로채기를 한 번만 설치한다. 브라우저가 아니면 아무것도 하지 않는다. */
export const installCapture = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  nativeFetch = window.fetch.bind(window);
  trackRefetchTriggers();
  interceptFetch();
  interceptXhr();
  interceptJsonParse();
};
