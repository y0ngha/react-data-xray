import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { mockFetch } from '../../../testing/fetchMock.js';
import { enqueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { installReportApi } from '../reportApi.js';

it('주기 업로드는 미뤄 둔 분석을 기다리지 않고, 사용자가 부르는 report() 는 끝까지 마친다', async () => {
  vi.useFakeTimers(); // 배경 구동이 먼저 비우지 못하게
  try {
    mockFetch.mockImplementation(async () => new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }));
    let ran = false;
    enqueue(() => (ran = true));
    installReportApi();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch.mock.calls.some(([input, init]) => input === REPORT_PATH && init?.method === 'POST')).toBe(true);
    expect(ran).toBe(false);
    expect(isQueuePending()).toBe(true);
    window.__RDX__!.report();
    expect(ran).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
