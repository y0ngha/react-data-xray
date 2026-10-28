// 렌더 감시는 react-dom 보다 먼저 평가돼야 React 의 commit 을 받을 수 있다.
import '../core/render/monitor.js';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { installCapture } from '../core/capture/install.js';
import { flushQueue } from '../core/scheduler/idleQueue.js';
import { clearRecords } from '../core/requests/store.js';
import { mockFetch, resetMockFetch } from './fetchMock.js';

// dev 서버 미들웨어 테스트는 node 환경에서 돈다. 브라우저 준비는 jsdom 에서만 한다.
const isBrowser = typeof window !== 'undefined';

// jsdom 에는 fetch 가 없어서, 가로채기를 설치하기 전에 가짜 fetch 를 둔다.
if (isBrowser) {
  window.fetch = mockFetch;
  installCapture();
}

beforeEach(() => {
  if (!isBrowser) return;
  clearRecords();
  resetMockFetch();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  flushQueue(); // 한 테스트가 남긴 일이 다음 테스트로 넘어가지 않게 렌더를 걷기 전에 비운다
  cleanup();
});
