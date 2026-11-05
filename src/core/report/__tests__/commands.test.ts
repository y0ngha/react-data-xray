import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { notePolled, notePollSent, receiveCommands, shouldPoll, tabState } from '../commands.js';
import { getResetAt, installReportApi } from '../reportApi.js';

const mark = { [REPORT_HEADER]: '1' };
const callsTo = (prefix: string, method: string) =>
  mockFetch.mock.calls.filter(([input, init]) => String(input).startsWith(prefix) && (init?.method ?? 'GET') === method);
const headerOf = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

it('보고서가 그대로인 주기에는 CLI 를 쓰지 않으면 55초마다, 쓰는 중이면 5초마다 받아 가고, 아직 살아 있는 명령만 차례로 실행해 알린다(#69)', async () => {
  vi.useFakeTimers();
  try {
    let cli = false;
    let deliver = false;
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = { ...mark, ...(cli && { 'x-rdx-cli': '1' }) };
      // 실행 직전 확인: c3 는 그 사이 CLI 가 포기했다
      if (method === 'GET' && url.startsWith(`${REPORT_PATH}?command=`))
        return new Response(null, { status: url.includes('command=c3') ? 410 : 204, headers: mark });
      if (method === 'GET' && url.startsWith(`${REPORT_PATH}?tab=`) && deliver) {
        deliver = false;
        return jsonResponse(
          {
            commands: [
              { id: 'c1', op: 'reset' },
              { id: 'c2', op: 'snapshot', name: 'before' },
              { id: 'c3', op: 'reset' },
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
    // CLI 를 쓰지 않으면 5초 주기에는 받아 가지 않는다(업로드를 보낸 때부터 센다)
    await vi.advanceTimersByTimeAsync(50_000);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(0);
    // 55초가 지나면 받아 간다. dev 서버가 CLI 를 쓰는 중이라고 알리면 그때부터 5초마다
    cli = true;
    await vi.advanceTimersByTimeAsync(5000);
    const polls = callsTo(`${REPORT_PATH}?tab=`, 'GET');
    expect(polls).toHaveLength(1);
    expect(headerOf(polls[0][1], 'x-rdx-tab')).toBe('1');
    expect(getResetAt()).toBeNull();
    deliver = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo(`${REPORT_PATH}?tab=`, 'GET')).toHaveLength(2);
    expect(getResetAt()).not.toBeNull();
    expect(callsTo(`${REPORT_PATH}?name=before`, 'POST')).toHaveLength(1);
    // 셋 다 실행 직전에 살아 있는지 묻고, 410 인 c3 는 실행하지도 알리지도 않는다
    expect(callsTo(`${REPORT_PATH}?command=`, 'GET')).toHaveLength(3);
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

it('받아 가기 주기는 응답이 아니라 보낸 때부터 세고, 55초라 1분에 한 번 깨는 가려진 탭도 깰 때마다 받아 간다', () => {
  notePolled(new Response(null)); // 앞 테스트의 'CLI 쓰는 중' 표시를 지운다
  notePollSent(1_000_000);
  expect(shouldPoll(1_000_000 + 54_999)).toBe(false);
  expect(shouldPoll(1_000_000 + 55_000)).toBe(true);
  expect(shouldPoll(1_000_000 + 60_000)).toBe(true);
});

it('포커스가 있으면 focusedAgo=0, 포커스를 잃으면 그 뒤로 지난 시간이고, 다시 보이는 것은 포커스로 치지 않는다', () => {
  const focus = vi.spyOn(document, 'hasFocus');
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  try {
    focus.mockReturnValue(true);
    expect(tabState()).toEqual({ visible: '1', focusedAgo: '0' });
    focus.mockReturnValue(false);
    vi.useFakeTimers();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(3000);
    expect(tabState().focusedAgo).toBe('3000');
    // 다른 창 뒤에서 드러났을 뿐이면 포커스를 잃은 시각을 바꾸지 않는다
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1000);
    expect(tabState().focusedAgo).toBe('4000');
    visibility.mockReturnValue('hidden');
    expect(tabState().visible).toBe('0');
  } finally {
    vi.useRealTimers();
    focus.mockRestore();
    visibility.mockRestore();
  }
});

it('실패한 명령은 오류 문구를 알리고, 결과를 알리지 못하면(5xx·응답 없음) 몇 번 더 보낸다. 명령이 없거나 JSON 이 아닌 답은 읽지 않는다', async () => {
  vi.useFakeTimers();
  try {
    let resultTries = 0;
    const send = vi.fn<typeof fetch>(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response(null, { status: 204 });
      resultTries++;
      if (resultTries === 1) throw new TypeError('network');
      return new Response(null, { status: resultTries === 2 ? 502 : 204 });
    });
    const runner = {
      reset: vi.fn<() => void>(),
      snapshot: vi.fn<(name: string) => Promise<unknown>>(async () => Promise.reject(new Error('no plugin'))),
    };
    await receiveCommands(send, new Response(null, { status: 204 }), 't', runner);
    await receiveCommands(send, new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 't', runner);
    await receiveCommands(send, new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 't', runner);
    expect(send).not.toHaveBeenCalled();
    const done = receiveCommands(send, jsonResponse({ commands: [{ id: 'c3', op: 'snapshot', name: 'x' }] }), 't', runner);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(runner.snapshot).toHaveBeenCalledWith('x');
    const posts = send.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ ok: false, error: 'no plugin' });
  } finally {
    vi.useRealTimers();
  }
});
