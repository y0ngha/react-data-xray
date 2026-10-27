import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import type { RequestClass } from '../../requests/classify.js';
import { getRecords } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { auditQueryCache, findQueryClients } from '../cacheAudit.js';

const sameOrOk = (r: RequestRecord): RequestClass => (r.sameResponseAs ? 'same-response' : 'ok');
const load = (url: string) => () => fetch(url).then((r) => r.json());

const withClient = (client: QueryClient, children: React.ReactNode) =>
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);

describe('React Query 캐시키 점검', () => {
  it('같은 요청을 서로 다른 키로 캐시하면 알린다', async () => {
    const A = () => <p>{useQuery({ queryKey: ['users'], queryFn: load('/api/users') }).data ? 'a' : ''}</p>;
    const B = () => <p>{useQuery({ queryKey: ['members'], queryFn: load('/api/users') }).data ? 'b' : ''}</p>;
    withClient(
      new QueryClient(),
      <>
        <A />
        <B />
      </>,
    );
    await screen.findByText('a');
    await screen.findByText('b');
    const found = auditQueryCache(sameOrOk, getRecords()).find((f) => f.kind === 'duplicate-cache');
    expect(found).toMatchObject({ keys: expect.arrayContaining(['["users"]', '["members"]']), requests: ['GET /api/users'] });
  });

  it('같은 키에 다른 요청의 데이터가 들어오면 키에 파라미터가 빠졌다고 알린다', async () => {
    // 페이지마다 다른 데이터(같으면 React Query 의 structural sharing 이 이전 객체를 그대로 둔다)
    mockFetch.mockImplementation(async (input) => jsonResponse({ page: String(input), size: 20, total: 100 }));
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    await client.fetchQuery({ queryKey: ['list'], queryFn: load('/api/list?page=1') });
    auditQueryCache(sameOrOk, getRecords());
    await client.fetchQuery({ queryKey: ['list'], queryFn: load('/api/list?page=2') });
    const found = auditQueryCache(sameOrOk, getRecords()).find((f) => f.kind === 'key-missing-param');
    expect(found?.requests).toEqual(['GET /api/list?page=1', 'GET /api/list?page=2']);
  });

  it('무효화한 키와 맞는 쿼리가 없으면 부른 위치와 함께 알리고, 무효화는 그대로 한다', async () => {
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    await client.fetchQuery({ queryKey: ['todos', 1], queryFn: load('/api/todos/1') });
    expect(findQueryClients()).toContain(client);
    await client.invalidateQueries({ queryKey: ['todo'] });
    await client.invalidateQueries({ queryKey: ['todos'] });
    const misses = auditQueryCache(sameOrOk, getRecords()).filter((f) => f.kind === 'invalidate-miss');
    expect(misses.map((f) => f.keys[0])).toEqual(['["todo"]']);
    expect(misses[0].stack).toContain('cacheAudit.test');
    expect(client.getQueryState(['todos', 1])?.isInvalidated).toBe(true);
  });

  it('staleTime 0 인 쿼리가 같은 응답을 다시 받으면 알린다', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ same: true }));
    const client = new QueryClient();
    const View = () => <p>{useQuery({ queryKey: ['config'], queryFn: load('/api/config') }).data ? 'ready' : ''}</p>;
    withClient(client, <View />);
    await screen.findByText('ready');
    await act(() => client.refetchQueries({ queryKey: ['config'] }));
    await act(flush);
    await waitFor(() => expect(getRecords().some((r) => r.sameResponseAs)).toBe(true));
    expect(auditQueryCache(sameOrOk, getRecords()).some((f) => f.kind === 'stale-zero')).toBe(true);
  });
});
