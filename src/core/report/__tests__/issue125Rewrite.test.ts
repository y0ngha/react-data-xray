import { expect, it } from 'vitest';

import { NEXT_REWRITE_HEADER, REPORT_HEADER } from '../../../shared/reportPath.js';
import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { configure } from '../../config.js';
import { buildDiagnostics, problemCount } from '../../diagnostics/diagnostics.js';
import { installReportApi } from '../reportApi.js';

// #125: Next.js 의 middleware(proxy, next-intl 등)가 /__rdx/report 를 /ko/__rdx/report 로 rewrite 해 404 가 난다.
const rewritten = () =>
  new Response('<!doctype html>404', {
    status: 404,
    headers: { 'content-type': 'text/html', [NEXT_REWRITE_HEADER]: '/ko/__rdx/report' },
  });

it('rdx 표시 없이 rewrite 헤더가 오면 rewritten 으로 보고, matcher 에서 __rdx 를 빼라고 문제로 알린다', async () => {
  mockFetch.mockImplementation(async () => rewritten());
  installReportApi();
  configure({ reportPath: '/__rdx/report' });
  await flush();
  await flush();
  const d = buildDiagnostics();
  expect(d.reportPlugin).toBe('rewritten');
  expect(d.problems.join(' ')).toMatch(/rewrote \/__rdx\/report to \/ko\/__rdx\/report.*Exclude __rdx from its matcher/);
  expect(problemCount()).toBe(1);
  // 플러그인을 붙이라는 안내가 아니라 같은 rewrite 안내로 거부한다.
  await expect(window.__RDX__!.snapshot('s1')).rejects.toThrow(/Exclude __rdx from its matcher/);
});

it('matcher 를 고쳐 rdx 가 답하면 ready 로 돌아오고 문제가 사라진다', async () => {
  mockFetch.mockImplementation(async (input) =>
    String(input).startsWith('/x/') ? rewritten() : new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }),
  );
  configure({ reportPath: '/x/__rdx/report' });
  await flush();
  expect(buildDiagnostics().reportPlugin).toBe('rewritten');
  configure({ reportPath: '/__rdx/report' });
  await flush();
  expect(buildDiagnostics().reportPlugin).toBe('ready');
  expect(buildDiagnostics().problems).toEqual([]);
});
