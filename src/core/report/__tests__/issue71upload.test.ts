import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { mockFetch } from '../../../testing/fetchMock.js';
import { enqueue, flushQueue } from '../../scheduler/idleQueue.js';
import type { RdxReport } from '../buildReport.js';
import { installReportApi } from '../reportApi.js';

const tabUploads = () =>
  mockFetch.mock.calls
    .filter(([input, init]) => String(input).startsWith(`${REPORT_PATH}?tab=`) && init?.method === 'POST')
    .map(([input, init]) => ({ idle: String(input).includes('idle=1'), body: JSON.parse(String(init?.body)) as RdxReport }));

it('upload_churn: 덜 분석된 파일은 분석이 끝나면 한 번 따라잡고, 그 뒤 멈춘 앱(패널이 도는 중)은 5초마다 다시 보내지 않는다', async () => {
  await new Promise((resolve) => setTimeout(resolve, 60)); // 앞서 걸린 실제 타이머의 큐 구동이 끝나게 한다
  vi.useFakeTimers(); // 배경 구동이 먼저 비우지 못하게
  try {
    mockFetch.mockImplementation(async () => new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }));
    enqueue(() => true); // 첫 업로드 때 남아 있는 분석
    installReportApi();
    await vi.advanceTimersByTimeAsync(0);
    expect(tabUploads().map((u) => [u.idle, u.body.complete])).toEqual([[false, false]]);

    // 유휴 틱에 분석이 끝났다. 내용은 그대로지만 complete 가 true 로 바뀌어 한 번 보낸다.
    flushQueue();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tabUploads().map((u) => [u.idle, u.body.complete])).toEqual([
      [false, false],
      [false, true],
    ]);

    // 패널이 화면 일(ui step)을 계속 넣고, 분석 step 이 남은 채로 업로드 시점이 와도 보고서가 그대로면 보내지 않는다.
    for (let i = 0; i < 4; i++) {
      enqueue(() => true, 'ui');
      if (i % 2 === 0) enqueue(() => true);
      await vi.advanceTimersByTimeAsync(5000);
      flushQueue();
    }
    expect(tabUploads()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
