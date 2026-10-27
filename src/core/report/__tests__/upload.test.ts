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
