import { interceptFetch } from './fetchInterceptor.js';
import { keepNativeFetch } from './nativeFetch.js';
import { interceptJsonParse } from './jsonParseInterceptor.js';
import { trackRefetchTriggers } from './requestContext.js';
import { interceptXhr } from './xhrInterceptor.js';
import { onActionNames } from '../requests/serverActionNames.js';
import { touchRecords } from '../requests/store.js';

let installed = false;

/** 요청 가로채기를 한 번만 설치한다. 브라우저가 아니면 아무것도 하지 않는다. */
export const installCapture = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  trackRefetchTriggers();
  // fetch·XHR 이 없는 환경(Jest + jsdom 등)에서도 import 만으로 깨지지 않게, 있는 것만 감싼다.
  if (typeof window.fetch === 'function' && typeof Response !== 'undefined') {
    keepNativeFetch(window.fetch.bind(window));
    interceptFetch();
  }
  if (typeof XMLHttpRequest !== 'undefined') interceptXhr();
  interceptJsonParse();
  // Server Action 이름을 찾으면 엔드포인트 이름이 바뀌므로 화면을 다시 그린다.
  onActionNames(touchRecords);
};
