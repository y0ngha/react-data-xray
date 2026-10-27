import { expect, it } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { isRenderMonitoring } from '../../render/monitor.js';
import { getRecords } from '../../requests/store.js';
import { installReportApi } from '../reportApi.js';

it('dev 서버 미들웨어가 표시 헤더로 답하면 보고서를 보내고 렌더 감시를 켜며, 자기 요청은 기록에 남기지 않는다', async () => {
  mockFetch.mockImplementation(async () => new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }));
  installReportApi();
  await flush();
  await flush();
  const upload = mockFetch.mock.calls.find(([input, init]) => input === REPORT_PATH && init?.method === 'POST');
  expect(JSON.parse(String(upload?.[1]?.body))).toHaveProperty('requests.endpoints');
  expect(upload?.[1]?.credentials).toBe('omit');
  expect(isRenderMonitoring()).toBe(true);
  expect(window.__RDX__?.report().renders.monitoring).toBe(true);
  expect(getRecords()).toHaveLength(0);
});

it('snapshot 은 이름 붙인 보고서를 보내고, reset 은 기록을 비우며, 이상한 이름은 거절한다', async () => {
  await fetch('/api/before').then((r) => r.json());
  const before = await window.__RDX__!.snapshot('before');
  expect(before.requests.total).toBeGreaterThan(0);
  expect(mockFetch.mock.calls.some(([input]) => String(input) === `${REPORT_PATH}?name=before`)).toBe(true);
  window.__RDX__!.reset();
  expect(window.__RDX__!.report().requests.total).toBe(0);
  await expect(window.__RDX__!.snapshot('../x')).rejects.toThrow(/보고서 이름/);
});

it('snapshot 은 dev 서버가 쓰지 못하면 거부되어, 파일이 없다는 것을 호출한 쪽이 안다', async () => {
  mockFetch.mockImplementation(async (input, init) =>
    init?.method === 'POST' && String(input).includes('name=') ? new Response(null, { status: 500 }) : new Response('{}'),
  );
  await expect(window.__RDX__!.snapshot('after')).rejects.toThrow(/after\.json/);
});
