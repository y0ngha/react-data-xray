import { vi } from 'vitest';
import { flushQueue } from '../core/scheduler/idleQueue.js';

export const jsonResponse = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });

export const DEFAULT_BODY = {
  data: {
    list: [
      { id: 101, title: 'CPU 경고' },
      { id: 102, title: '메모리 경고' },
    ],
  },
};

/** 가로채기 아래에 있는 실제 fetch 자리. install 뒤 window.fetch 는 래퍼라 이 참조로 응답을 바꾼다. */
export const mockFetch = vi.fn<typeof fetch>();

export const resetMockFetch = (): void => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => jsonResponse(DEFAULT_BODY));
};

/** 가로채기가 응답 원문을 복제본으로 비동기로 읽으므로, 판정이 끝나도록 한 틱 기다린다. */
export const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
    flushQueue(); // 한가한 틱으로 미룬 분석도 마저 끝낸다
  });
