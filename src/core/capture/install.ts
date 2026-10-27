import { interceptFetch } from './fetchInterceptor.js';
import { interceptJsonParse } from './jsonParseInterceptor.js';
import { trackRefetchTriggers } from './requestContext.js';
import { interceptXhr } from './xhrInterceptor.js';

let installed = false;

/** 요청 가로채기를 한 번만 설치한다. 브라우저가 아니면 아무것도 하지 않는다. */
export const installCapture = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  trackRefetchTriggers();
  interceptFetch();
  interceptXhr();
  interceptJsonParse();
};
