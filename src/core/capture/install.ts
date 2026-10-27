import { interceptFetch } from './fetchInterceptor.js';
import { interceptJsonParse } from './jsonParseInterceptor.js';
import { trackRefetchTriggers } from './requestContext.js';
import { interceptXhr } from './xhrInterceptor.js';

let installed = false;
let nativeFetch: typeof fetch | undefined;

/** 가로채기 전의 fetch. rdx 가 스스로 보내는 요청이 기록에 섞이지 않게 쓴다. */
export const getNativeFetch = (): typeof fetch | undefined => nativeFetch ?? window.fetch;

/** 요청 가로채기를 한 번만 설치한다. 브라우저가 아니면 아무것도 하지 않는다. */
export const installCapture = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // fetch 가 없는 환경(Jest + jsdom 등)에서도 import 만으로 깨지지 않게 한다.
  nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;
  trackRefetchTriggers();
  interceptFetch();
  interceptXhr();
  interceptJsonParse();
};
