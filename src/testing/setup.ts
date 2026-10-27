// 렌더 감시는 react-dom 보다 먼저 평가돼야 React 의 commit 을 받을 수 있다.
import '../core/render/monitor.js';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { installCapture } from '../core/capture/install.js';
import { clearRecords } from '../core/requests/store.js';
import { mockFetch, resetMockFetch } from './fetchMock.js';

// jsdom 에는 fetch 가 없어서, 가로채기를 설치하기 전에 가짜 fetch 를 둔다.
window.fetch = mockFetch;
installCapture();

beforeEach(() => {
  clearRecords();
  resetMockFetch();
  localStorage.clear();
});

afterEach(() => cleanup());
