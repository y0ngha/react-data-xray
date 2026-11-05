import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { findQueryClients } from '../../reactQuery/cacheAudit.js';
import { enqueue, flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
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
  expect(periodic).toMatchObject({
    complete: false,
    incompleteReasons: ['pending-analysis'],
    sourcesResolved: true,
    queryKeysResolved: true,
  });
  expect(periodic.pendingAnalysis).toBeGreaterThan(0);
  expect(isQueuePending()).toBe(true);
  // 사용자가 부르는 보고서는 큐를 비우므로 끝난 보고서다
  expect(buildReport(false)).toMatchObject({ complete: true, incompleteReasons: [], pendingAnalysis: 0, sourcesResolved: true });
});

it('ui_steps: 화면만 쓰는 step(오버레이·렌더 탭)은 남은 분석으로 세지 않는다', () => {
  flushQueue();
  enqueue(() => true, 'ui');
  const periodic = buildReport(false, Date.now(), false);
  expect(isQueuePending()).toBe(true);
  expect(periodic).toMatchObject({ complete: true, pendingAnalysis: 0, incompleteReasons: [] });
  flushQueue();
});

it('query_keys: React Query 요청의 queryKey 문맥을 찾기 전인 주기 보고서는 query-keys 로 덜 끝난 것이다', async () => {
  mockFetch.mockImplementation(async () => jsonResponse([{ id: 1 }]));
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <p>app</p>
    </QueryClientProvider>,
  );
  findQueryClients();
  await client.fetchQuery({ queryKey: ['todos71'], queryFn: () => fetch('/api/todos71').then((r) => r.json()) });
  await flush();
  flushQueue();
  const periodic = buildReport(false, Date.now(), false);
  expect(periodic).toMatchObject({ complete: false, queryKeysResolved: false, incompleteReasons: expect.arrayContaining(['query-keys']) });
  // 사용자 조회는 모든 요청의 문맥을 찾아 본다. 그 뒤의 주기 보고서도 찾아 둔 것을 쓴다
  expect(buildReport(false)).toMatchObject({ queryKeysResolved: true });
  expect(buildReport(false).incompleteReasons).not.toContain('query-keys');
  expect(buildReport(false, Date.now(), false)).toMatchObject({ queryKeysResolved: true });
  cleanup();
});

it('periodic_upload_incomplete: 5초 주기 파일은 큐를 비우지 않고 complete: false 로 남는다', async () => {
  await new Promise((resolve) => setTimeout(resolve, 60)); // 앞서 걸린 실제 타이머의 큐 구동이 끝나게 한다
  vi.useFakeTimers(); // 배경 구동이 먼저 비우지 못하게
  try {
    pluginReady();
    // 업로드 본문을 만들 때 이 step 이 남아 있었다(주기 업로드가 큐를 비웠다면 pendingAnalysis 가 0 이다).
    enqueue(() => true);
    installReportApi();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads().at(-1)).toMatchObject({ complete: false, sourcesResolved: true });
    expect(uploads().at(-1)!.pendingAnalysis).toBeGreaterThan(0);
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

it('change_key: 완료 표시만 다른 보고서는 같은 것으로 본다(주기 업로드를 건너뛴다)', async () => {
  await flush();
  const { generatedAt: _g, ...content } = buildReport(false, 0, false);
  expect(
    changeKeyOf({
      ...content,
      complete: false,
      incompleteReasons: ['pending-analysis', 'source-maps', 'query-keys'],
      pendingAnalysis: 7,
      sourcesResolved: false,
      queryKeysResolved: false,
    }),
  ).toBe(
    changeKeyOf({ ...content, complete: true, incompleteReasons: [], pendingAnalysis: 0, sourcesResolved: true, queryKeysResolved: true }),
  );
});

it('compare_incomplete: 덜 분석된 보고서와 비교하면 경고한다', () => {
  const done = toComparable(buildReport(false));
  expect(done.complete).toBe(true);
  expect(compare(done, done).warnings.some((w) => w.includes('complete: false'))).toBe(false);
  const late = { ...done, complete: false, incompleteReasons: ['source-map-timeout'] };
  expect(compare(done, late).warnings.find((w) => w.includes('complete: false'))).toContain('after (source-map-timeout)');
  const both = compare({ ...done, complete: false, incompleteReasons: ['pending-analysis', 'query-keys'] }, late).warnings.find((w) =>
    w.includes('complete: false'),
  );
  expect(both).toContain('before (pending-analysis, query-keys); after (source-map-timeout)');
  // 이 필드 전에 저장한 스냅샷(complete 없음)은 경고하지 않는다
  const { complete: _c, ...old } = done;
  expect(compare(old, done).warnings.some((w) => w.includes('complete: false'))).toBe(false);
});

it('how_to_read_complete: howToRead 가 complete 가 false 면 snapshot 으로 비교하라고 적는다', () => {
  const line = HOW_TO_READ.find((l) => l.startsWith('complete is false'));
  expect(line).toContain('snapshot');
  expect(line).toContain('up to 2s');
  expect(line).toContain('report() is a quick read');
});
