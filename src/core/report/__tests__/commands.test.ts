import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { receiveCommands, tabState } from '../commands.js';
import { getResetAt, installReportApi } from '../reportApi.js';

const mark = { [REPORT_HEADER]: '1' };
const callsTo = (prefix: string, method: string) =>
  mockFetch.mock.calls.filter(([input, init]) => String(input).startsWith(prefix) && (init?.method ?? 'GET') === method);
const headerOf = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

it('보고서가 그대로인 주기에는 CLI 를 쓰지 않으면 1분마다, 쓰는 중이면 5초마다 받아 가고, 받은 명령을 차례로 실행해 알린다(#69)', async () => {
  vi.useFakeTimers();
  try {
    let cli = false;
    let deliver = false;
    mockFetch.mockImplementation(async (input, init) => {
      const headers = { ...mark, ...(cli && { 'x-rdx-cli': '1' }) };
      if ((init?.method ?? 'GET') === 'GET' && String(input).startsWith(`${REPORT_PATH}?tab=`) && deliver) {
        deliver = false;
        return jsonResponse(
          {
            commands: [
              { id: 'c1', op: 'reset' },
              { id: 'c2', op: 'snapshot', name: 'before' },
              { id: 'bad', op: 'eval' },
            ],
          },
          { headers },
        );
      }
      return new Response(null, { status: 204, headers });
    });
    installReportApi();
    await vi.advanceTimersByTimeAsync(0);
    // 첫 주기는 보고서를 올린다(POST). 탭 헤더와 보이는지를 붙인다
    const [upload] = callsTo(`${REPORT_PATH}?tab=`, 'POST');
    expect(headerOf(upload[1], 'x-rdx-tab')).toBe('1');
    expect(new URL(String(upload[0]), 'http://x').searchParams.get('visible')).toBe('1');
    // CLI 를 쓰지 않으면 5초 주기에는 받아 가지 않는다
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(0);
    // 1분이 지나면 받아 간다. dev 서버가 CLI 를 쓰는 중이라고 알리면 그때부터 5초마다
    cli = true;
    await vi.advanceTimersByTimeAsync(55_000);
    const polls = callsTo(`${REPORT_PATH}?tab=`, 'GET');
    expect(polls).toHaveLength(1);
    expect(headerOf(polls[0][1], 'x-rdx-tab')).toBe('1');
    expect(getResetAt()).toBeNull();
    deliver = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(2);
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

it('포커스를 받으면 그 뒤로 얼마나 지났는지 알리고, 가려지면 visible=0 이다', () => {
  window.dispatchEvent(new Event('focus'));
  expect(tabState()).toMatchObject({ visible: '1', focusedAgo: expect.stringMatching(/^\d+$/) });
  const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    expect(tabState().visible).toBe('0');
  } finally {
    spy.mockRestore();
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
