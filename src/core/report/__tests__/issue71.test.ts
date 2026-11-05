import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { enqueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { buildReport, HOW_TO_READ } from '../buildReport.js';
import { compare, toComparable } from '../compare.js';
import { changeKeyOf, installReportApi } from '../reportApi.js';

// 보고서 경로에는 미들웨어 표시 헤더로 답하고, 앱 요청에는 JSON 을 준다.
const pluginReady = () =>
  mockFetch.mockImplementation(async (input) =>
    String(input).startsWith(REPORT_PATH)
      ? new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } })
      : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
  );
const uploads = () =>
  mockFetch.mock.calls
    .filter(([input, init]) => String(input).startsWith(`${REPORT_PATH}?tab=`) && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as ReturnType<typeof buildReport>);

it('report_incomplete: 큐를 비우지 않는 보고서는 남은 분석 수와 complete: false 를 싣고, 큐는 그대로 둔다', () => {
  enqueue(() => true);
  const periodic = buildReport(false, Date.now(), false);
  expect(periodic).toMatchObject({ complete: false, sourcesResolved: true });
  expect(periodic.pendingAnalysis).toBeGreaterThan(0);
  expect(isQueuePending()).toBe(true);
  // 사용자가 부르는 보고서는 큐를 비우므로 끝난 보고서다
  expect(buildReport(false)).toMatchObject({ complete: true, pendingAnalysis: 0, sourcesResolved: true });
});

it('periodic_upload_incomplete: 5초 주기 파일은 큐를 비우지 않고 complete: false 로 남는다', async () => {
  vi.useFakeTimers(); // 배경 구동이 먼저 비우지 못하게
  try {
    pluginReady();
    let ran = false;
    enqueue(() => (ran = true));
    installReportApi();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads().at(-1)).toMatchObject({ complete: false, sourcesResolved: true });
    expect(uploads().at(-1)!.pendingAnalysis).toBeGreaterThan(0);
    expect(ran).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('snapshot_complete: snapshot 결과는 분석과 소스맵 변환을 마친 complete: true 다', async () => {
  pluginReady();
  await fetch('/api/x71').then((r) => r.json());
  enqueue(() => true);
  const saved = await window.__RDX__!.snapshot('before71');
  expect(saved).toMatchObject({ complete: true, pendingAnalysis: 0, sourcesResolved: true });
  const posted = mockFetch.mock.calls.find(([input]) => String(input) === `${REPORT_PATH}?name=before71`);
  expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({ complete: true });
});

it('change_key: 남은 분석 수만 바뀐 보고서는 같은 것으로 보고(주기 업로드를 건너뛴다), complete 가 바뀌면 다르게 본다', async () => {
  await flush();
  const { generatedAt: _g, ...content } = buildReport(false, 0, false);
  expect(changeKeyOf({ ...content, pendingAnalysis: 3, complete: false })).toBe(
    changeKeyOf({ ...content, pendingAnalysis: 7, complete: false }),
  );
  expect(changeKeyOf({ ...content, pendingAnalysis: 0, complete: true })).not.toBe(
    changeKeyOf({ ...content, pendingAnalysis: 3, complete: false }),
  );
});

it('compare_incomplete: 덜 분석된 보고서와 비교하면 경고한다', () => {
  const done = toComparable(buildReport(false));
  expect(done.complete).toBe(true);
  expect(compare(done, done).warnings.some((w) => w.includes('complete: false'))).toBe(false);
  expect(compare(done, { ...done, complete: false }).warnings.some((w) => w.includes('complete: false'))).toBe(true);
  // 이 필드 전에 저장한 스냅샷(complete 없음)은 경고하지 않는다
  const { complete: _c, ...old } = done;
  expect(compare(old, done).warnings.some((w) => w.includes('complete: false'))).toBe(false);
});

it('how_to_read_complete: howToRead 가 complete 가 false 면 snapshot 으로 비교하라고 적는다', () => {
  expect(HOW_TO_READ.some((l) => l.startsWith('complete is false') && l.includes('snapshot'))).toBe(true);
});
