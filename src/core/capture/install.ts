import { interceptFetch } from './fetchInterceptor.js';
import { keepNativeFetch } from './nativeFetch.js';
import { interceptJsonParse } from './jsonParseInterceptor.js';
import { trackRefetchTriggers } from './requestContext.js';
import { trackNavigation } from './navigation.js';
import { interceptRequestOrigins } from './requestOrigins.js';
import { interceptXhr } from './xhrInterceptor.js';
import { onActionNames } from '../requests/serverActionNames.js';
import { touchRecords } from '../requests/store.js';

let installed = false;
let fetchWrapped = false;
let xhrWrapped = false;
// 설치한 시각(performance.now 기준). 이보다 먼저 시작한 fetch·XHR 은 기록하지 못했다(#75).
let installedAt: number | null = null;

/** 가로채기 설치 상태: 설치했는지, 감싼 것, 설치 시각(performance.now 기준, 모르면 null) */
export const captureStatus = (): { installed: boolean; fetch: boolean; xhr: boolean; installedAt: number | null } => ({
  installed,
  fetch: fetchWrapped,
  xhr: xhrWrapped,
  installedAt,
});

/** 요청 가로채기를 한 번만 설치한다. 브라우저가 아니면 아무것도 하지 않는다. */
export const installCapture = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  installedAt = typeof performance === 'undefined' ? null : performance.now();
  trackRefetchTriggers();
  trackNavigation();
  // fetch·XHR 이 없는 환경(Jest + jsdom 등)에서도 import 만으로 깨지지 않게, 있는 것만 감싼다.
  if (typeof window.fetch === 'function' && typeof Response !== 'undefined') {
    keepNativeFetch(window.fetch.bind(window));
    interceptFetch();
    interceptRequestOrigins();
    fetchWrapped = true;
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    interceptXhr();
    xhrWrapped = true;
  }
  interceptJsonParse();
  // Server Action 이름을 찾으면 엔드포인트 이름이 바뀌므로 화면을 다시 그린다.
  onActionNames(touchRecords);
};
