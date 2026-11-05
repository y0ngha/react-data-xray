import { expect, it, vi } from 'vitest';

import { REPORT_HEADER } from '../../../shared/reportPath.js';
import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { buildReport } from '../buildReport.js';
import { installReportApi } from '../reportApi.js';

// 소스맵 변환이 2초 안에 끝나지 않는 경우를 만든다(변환 중으로 두고, 기다림은 상한에서 끝났다고 답한다).
vi.mock('../../capture/requestContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capture/requestContext.js')>()),
  areSourcesResolved: () => false,
  whenSourcesResolved: async () => false,
}));

it('source_map_reasons: 변환 중이면 source-maps, snapshot 이 2초 기다리고도 끝나지 않았으면 source-map-timeout 이다', async () => {
  expect(buildReport(false)).toMatchObject({ complete: false, sourcesResolved: false, incompleteReasons: ['source-maps'] });
  mockFetch.mockImplementation(async () => new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }));
  installReportApi();
  await flush();
  const saved = await window.__RDX__!.snapshot('slow71');
  expect(saved).toMatchObject({ complete: false, sourcesResolved: false, incompleteReasons: ['source-map-timeout'] });
});
