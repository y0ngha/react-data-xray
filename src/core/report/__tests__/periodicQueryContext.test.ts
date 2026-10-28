import { expect, it, vi } from 'vitest';

import { mockFetch, jsonResponse } from '../../../testing/fetchMock.js';
import { buildReport } from '../buildReport.js';

const { queryContextOf } = vi.hoisted(() => ({ queryContextOf: vi.fn<(record: unknown) => undefined>() }));
vi.mock('../../capture/queryContext.js', async (importActual) => {
  const actual = await importActual<typeof import('../../capture/queryContext.js')>();
  queryContextOf.mockImplementation((record) => actual.queryContextOf(record as never) as undefined);
  return { ...actual, queryContextOf };
});

it('#12·#13: 주기 업로드(drain=false)는 fiber 트리를 걷지 않고, 사용자 조회(drain=true)는 걷는다', async () => {
  mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
  await fetch('/api/q');
  queryContextOf.mockClear();
  buildReport(true, Date.now(), false);
  expect(queryContextOf).not.toHaveBeenCalled();
  buildReport(true, Date.now(), true);
  expect(queryContextOf).toHaveBeenCalled();
});
