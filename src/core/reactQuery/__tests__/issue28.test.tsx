import { QueryClient, QueryObserver, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { classifyRecords } from '../../requests/classify.js';
import { getRecords } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { findQueryClients, refetchReason } from '../cacheAudit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const setup = () => {
  mockFetch.mockImplementation(async () => jsonResponse({ ok: true }));
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <p>app</p>
    </QueryClientProvider>,
  );
  findQueryClients();
  // 테스트마다 다른 URL 이라 앞선 테스트의 요청과 섞이지 않는다.
  const url = `/api/t28-${++n}`;
  const fetchOnce = (staleTime: number, key: unknown[] = ['t28', n]) =>
    client.fetchQuery({ queryKey: key, staleTime, queryFn: () => fetch(url).then((r) => r.json()) });
  const last = async (): Promise<RequestRecord> => {
    await flush();
    const record = getRecords().find((r) => r.url === url && r.sameResponseAs !== undefined) ?? getRecords().find((r) => r.url === url)!;
    record.duplicateOf = undefined; // 실제 재조회는 2초 넘게 떨어져 있다(테스트는 짧게 잰다)
    return record;
  };
  return { client, fetchOnce, last };
};

describe('이슈 28: 의도된 재조회 구분', () => {
  it('stale-elapsed: staleTime 이 지나 다시 받은 같은 응답', async () => {
    const { fetchOnce, last } = setup();
    await fetchOnce(20);
    await sleep(40);
    await fetchOnce(20);
    const r = await last();
    expect(r.sameResponseAs).toBeDefined();
    expect(refetchReason(r)).toBe('stale-elapsed');
    expect(classifyRecords([r], new Set()).get(r.id)).toBe('stale-elapsed');
  });

  it('stale-zero: staleTime 0 관찰자의 같은 응답은 빨강(same-response)으로 남고 원인만 붙는다', async () => {
    const { client, fetchOnce, last } = setup();
    // 관찰자(staleTime 0)가 있어야 "화면을 옮길 때마다 받는" 쿼리로 본다.
    const key = ['t28', n];
    new QueryObserver(client, { queryKey: key, enabled: false, staleTime: 0, queryFn: () => null }).subscribe(() => {});
    await fetchOnce(0, key);
    await sleep(5);
    await fetchOnce(0, key);
    const r = await last();
    expect(refetchReason(r)).toBe('stale-zero');
    expect(classifyRecords([r], new Set()).get(r.id)).toBe('same-response');
  });

  it('after-invalidate: 무효화 직후 다시 받은 같은 응답', async () => {
    const { client, fetchOnce, last } = setup();
    await fetchOnce(60_000);
    await client.invalidateQueries({ queryKey: ['t28'] });
    await fetchOnce(60_000);
    const r = await last();
    expect(refetchReason(r)).toBe('after-invalidate');
    expect(classifyRecords([r], new Set()).get(r.id)).toBe('after-invalidate');
  });

  it('after-invalidate: 앞 성공·무효화·재조회가 같은 밀리초에 겹쳐도 앞 성공을 이 요청의 성공으로 보지 않는다', async () => {
    const { client, fetchOnce, last } = setup();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await fetchOnce(60_000);
      await client.invalidateQueries({ queryKey: ['t28'] });
      await fetchOnce(60_000);
      const r = await last();
      expect(refetchReason(r)).toBe('after-invalidate');
    } finally {
      now.mockRestore();
    }
  });

  it('첫 요청이거나 React Query 를 거치지 않은 요청은 원인이 없다', async () => {
    const { fetchOnce, last } = setup();
    await fetchOnce(0);
    expect(refetchReason(await last())).toBeUndefined();
    expect(refetchReason({ id: 9999, startedAt: 0, durationMs: 1 } as RequestRecord)).toBeUndefined();
  });
});

describe('이슈 28: 새로고침 경계', () => {
  const rec = (extra: Partial<RequestRecord>): RequestRecord =>
    ({
      id: 1,
      kind: 'fetch',
      method: 'GET',
      url: '/api/me',
      status: 200,
      startedAt: 0,
      durationMs: 1,
      body: null,
      ...extra,
    }) as RequestRecord;

  it('reload_boundary: 새로고침 전 기록과 같은 응답이어도 낭비로 잡지 않는다', () => {
    const before = rec({ id: 1, restored: true, load: 1 });
    const after = rec({ id: 2, load: 2, startedAt: 100, sameResponseAs: 1 });
    expect(classifyRecords([before, after], new Set()).get(2)).toBe('ok');
  });

  it('같은 페이지 로드 안의 같은 응답은 그대로 낭비다', () => {
    const a = rec({ id: 1, load: 2 });
    const b = rec({ id: 2, load: 2, startedAt: 5000, sameResponseAs: 1 });
    expect(classifyRecords([a, b], new Set()).get(2)).toBe('same-response');
  });

  it('한 번 정해진 원인은 성공 이력이 밀려나도 그대로다', async () => {
    const { client, fetchOnce, last } = setup();
    await fetchOnce(20);
    await sleep(40);
    await fetchOnce(20);
    const r = await last();
    expect(classifyRecords([r], new Set()).get(r.id)).toBe('stale-elapsed');
    client.clear(); // 이력(쿼리 캐시)이 사라져도
    expect(refetchReason(r)).toBe('stale-elapsed');
    expect(classifyRecords([r], new Set()).get(r.id)).toBe('stale-elapsed');
  });
});
