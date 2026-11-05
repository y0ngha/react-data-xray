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

it('reportPath 를 바꾸면 그 경로를 다시 확인하고, 확인되지 않은 경로로는 snapshot 을 보내지 않는다', async () => {
  // /b 는 미들웨어가 없는 경로(표시 헤더 없음), /c 는 있는 경로
  mockFetch.mockImplementation(async (input) =>
    String(input).startsWith('/b/') ? new Response('{}') : new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }),
  );
  configure({ reportPath: '/b/__rdx/report' });
  await expect(window.__RDX__!.snapshot('s1')).rejects.toThrow(/no rdx plugin/);
  const toB = mockFetch.mock.calls.filter(([input]) => String(input).startsWith('/b/'));
  expect(toB.map(([, init]) => init?.method)).toEqual(['GET']);
  configure({ reportPath: '/c/__rdx/report' });
  await flush();
  await window.__RDX__!.snapshot('s2');
  const toC = mockFetch.mock.calls
    .filter(([input]) => String(input).startsWith('/c/'))
    .map(([input, init]) => `${init?.method} ${String(input)}`);
  expect(toC[0]).toBe('GET /c/__rdx/report');
  expect(toC).toContain('POST /c/__rdx/report?name=s2');
});
