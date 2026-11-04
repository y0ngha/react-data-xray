import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { receiveCommands } from '../commands.js';
import { getResetAt, installReportApi } from '../reportApi.js';

const mark = { [REPORT_HEADER]: '1' };
const callsTo = (prefix: string, method: string) =>
  mockFetch.mock.calls.filter(([input, init]) => String(input).startsWith(prefix) && (init?.method ?? 'GET') === method);

it('업로드·받아 가기 응답으로 온 명령(reset·snapshot)을 차례로 실행하고 결과를 알린다(#69)', async () => {
  vi.useFakeTimers();
  try {
    let deliver = true;
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      // 보고서가 그대로인 주기의 받아 가기(GET ?tab=)에 명령 둘을 넘긴다
      if (method === 'GET' && url.startsWith(`${REPORT_PATH}?tab=`) && deliver) {
        deliver = false;
        return jsonResponse(
          {
            commands: [
              { id: 'c1', op: 'reset' },
              { id: 'c2', op: 'snapshot', name: 'before' },
              { id: 'bad', op: 'eval' },
            ],
          },
          { headers: mark },
        );
      }
      return new Response(null, { status: 204, headers: mark });
    });
    installReportApi();
    await vi.advanceTimersByTimeAsync(0);
    // 첫 주기는 보고서를 올린다(POST)
    expect(callsTo(`${REPORT_PATH}?tab=`, 'POST')).toHaveLength(1);
    expect(getResetAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    // 그대로라 올리지 않는 주기에도 본문 없는 GET 으로 받아 간다
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(1);
    expect(getResetAt()).not.toBeNull();
    expect(callsTo(`${REPORT_PATH}?name=before`, 'POST')).toHaveLength(1);
    const results = callsTo(`${REPORT_PATH}?command=`, 'POST').map(([input, init]) => [
      new URL(String(input), 'http://x').searchParams.get('command'),
      JSON.parse(String(init?.body)),
    ]);
    expect(results).toEqual([
      ['c1', { ok: true }],
      ['c2', { ok: true }],
    ]);
    expect(String(callsTo(`${REPORT_PATH}?command=`, 'POST')[0][0])).toContain('&tab=');
  } finally {
    vi.useRealTimers();
  }
});

it('실패한 명령은 오류 문구를 알리고, 명령이 없거나 JSON 이 아닌 답은 읽지 않는다', async () => {
  const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const runner = {
    reset: vi.fn<() => void>(),
    snapshot: vi.fn<(name: string) => Promise<unknown>>(async () => Promise.reject(new Error('no plugin'))),
  };
  await receiveCommands(send, new Response(null, { status: 204 }), 't', runner);
  await receiveCommands(send, new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 't', runner);
  await receiveCommands(send, new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 't', runner);
  expect(send).not.toHaveBeenCalled();
  await receiveCommands(send, jsonResponse({ commands: [{ id: 'c3', op: 'snapshot', name: 'x' }] }), 't', runner);
  expect(runner.snapshot).toHaveBeenCalledWith('x');
  expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({ ok: false, error: 'no plugin' });
});
