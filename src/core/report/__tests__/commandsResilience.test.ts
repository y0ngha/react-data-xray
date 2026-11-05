import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { mockFetch } from '../../../testing/fetchMock.js';
import { installReportApi } from '../reportApi.js';

const mark = { [REPORT_HEADER]: '1' };
const callsTo = (prefix: string, method: string) =>
  mockFetch.mock.calls.filter(([input, init]) => String(input).startsWith(prefix) && (init?.method ?? 'GET') === method);

it('업로드가 계속 실패해도(dev 서버 재시작) 멈추지 않고 받아 가기만 보내다가, 되면 다시 올린다. 받아 가기는 응답을 기다리지 않고 보낸 때부터 센다(#69)', async () => {
  vi.useFakeTimers();
  try {
    let serverUp = false;
    let hangPoll = true;
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === REPORT_PATH) return new Response(null, { status: 204, headers: mark }); // 핸드셰이크
      if (method === 'GET') {
        // 첫 받아 가기는 답이 오지 않는다(서버가 내려가 있는 동안)
        if (hangPoll) {
          hangPoll = false;
          return new Promise<Response>(() => undefined);
        }
        serverUp = true;
        return new Response(null, { status: 204, headers: mark });
      }
      if (!serverUp) throw new TypeError('connection refused');
      return new Response(null, { status: 204, headers: mark });
    });
    installReportApi();
    await vi.advanceTimersByTimeAsync(10_000); // 0·5·10초에 세 번 실패
    expect(callsTo(`${REPORT_PATH}?tab=`, 'POST')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(55_000); // 쉬는 중: 올리지 않는다. 마지막으로 보낸 10초에서 55초 뒤 받아 간다
    expect(callsTo(`${REPORT_PATH}?tab=`, 'POST')).toHaveLength(3);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(1);
    // 답이 오지 않아도 보낸 때부터 55초 뒤 다시 받아 간다
    await vi.advanceTimersByTimeAsync(55_000);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(2);
    // 받아 가기가 되었으니 다음 주기에 다시 올린다
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'POST')).toHaveLength(4);
  } finally {
    vi.useRealTimers();
  }
});
