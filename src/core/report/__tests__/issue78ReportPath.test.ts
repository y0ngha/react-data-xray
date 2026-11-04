import { expect, it } from 'vitest';

import { REPORT_HEADER } from '../../../shared/reportPath.js';
import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { configure } from '../../config.js';
import { installReportApi } from '../reportApi.js';

// #78: Next.js basePath 처럼 보고서 경로가 바뀌면 configure({ reportPath }) 로 정한다.
it('import 바로 뒤의 configure({ reportPath }) 가 설치보다 늦어도 그 경로로 확인하고 보낸다', async () => {
  mockFetch.mockImplementation(async () => new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }));
  // index.ts 가 import 될 때 설치하고, 앱 코드는 그 뒤에 같은 틱 안에서 configure 를 부른다.
  installReportApi();
  configure({ reportPath: '/app/__rdx/report' });
  await flush();
  await flush();
  const urls = mockFetch.mock.calls.map(([input]) => String(input));
  expect(urls[0]).toBe('/app/__rdx/report');
  expect(urls.some((u) => u.startsWith('/app/__rdx/report?tab='))).toBe(true);
  expect(urls.some((u) => u.startsWith('/__rdx/report'))).toBe(false);
});
