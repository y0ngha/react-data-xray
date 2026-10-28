import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import type { RequestClass } from '../../requests/classify.js';
import { enqueue, flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { getRecords } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { flushIndex } from '../../inspect/derivedMatch.js';
import { auditQueryCache, findQueryClients } from '../cacheAudit.js';

const sameOrOk = (r: RequestRecord): RequestClass => (r.sameResponseAs ? 'same-response' : 'ok');
// 사용자가 직접 묻는 조회처럼 미뤄 둔 분석을 먼저 마치고 점검한다(점검 자체는 큐를 비우지 않는다).
const audit: typeof auditQueryCache = (...args) => {
  flushIndex();
  flushQueue();
  return auditQueryCache(...args);
};
const load = (url: string) => () => fetch(url).then((r) => r.json());

const withClient = (client: QueryClient, children: React.ReactNode) =>
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);

describe('React Query 캐시키 점검', () => {
  it('점검은 큐에 남은 일을 대신 돌리지 않는다(주기적으로 불리므로)', async () => {
    const A = () => <p>{useQuery({ queryKey: ['flush'], queryFn: load('/api/users') }).data ? 'f' : ''}</p>;
    withClient(new QueryClient(), <A />);
    await screen.findByText('f');
    flushQueue();
    const ran = vi.fn<() => boolean>(() => true);
    enqueue(ran);
    auditQueryCache(sameOrOk, getRecords());
    findQueryClients();
    expect(ran).not.toHaveBeenCalled();
    expect(isQueuePending()).toBe(true);
  });

  it('출처를 못 찾는 이벤트는 큐에 일이 남아 있어도 3번 점검하면 버린다', async () => {
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    findQueryClients();
    // 복사본이라 같은 참조로는 못 찾고, 색인이 끝나야 필드 값으로 찾는다.
    mockFetch.mockImplementation(async (input) => jsonResponse([{ symbol: String(input), name: `name ${String(input)}` }]));
    const queryFn = (url: string) => () =>
      fetch(url)
        .then((r) => r.json())
        .then((j) => structuredClone(j));
    await client.fetchQuery({ queryKey: ['list'], queryFn: queryFn('/api/list?page=1') });
    await client.fetchQuery({ queryKey: ['list'], queryFn: queryFn('/api/list?page=2') });
    flushQueue();
    let hold = true;
    enqueue(() => !hold); // 색인을 붙잡아 두어, 점검마다 못 찾은 채 큐가 남게 한다
    [1, 2, 3].forEach(() => auditQueryCache(sameOrOk, getRecords()));
    expect(isQueuePending()).toBe(true);
    hold = false;
    flushQueue();
    expect(auditQueryCache(sameOrOk, getRecords()).find((f) => f.kind === 'key-missing-param')).toBeUndefined();
  });

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
    const found = audit(sameOrOk, getRecords()).find((f) => f.kind === 'duplicate-cache');
    expect(found).toMatchObject({ keys: expect.arrayContaining(['["users"]', '["members"]']), requests: ['GET /api/users'] });
  });

  it('같은 키에 다른 요청의 데이터가 들어오면 키에 파라미터가 빠졌다고 알린다', async () => {
    // 페이지마다 다른 데이터(같으면 React Query 의 structural sharing 이 이전 객체를 그대로 둔다)
    mockFetch.mockImplementation(async (input) => jsonResponse({ page: String(input), size: 20, total: 100 }));
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    await client.fetchQuery({ queryKey: ['list'], queryFn: load('/api/list?page=1') });
    audit(sameOrOk, getRecords());
    await client.fetchQuery({ queryKey: ['list'], queryFn: load('/api/list?page=2') });
    const found = audit(sameOrOk, getRecords()).find((f) => f.kind === 'key-missing-param');
    expect(found?.requests).toEqual(['GET /api/list?page=1', 'GET /api/list?page=2']);
  });

  it('목록(배열) 응답도 두 번째 조회부터 출처를 잃지 않고 키에 빠진 인자를 찾는다', async () => {
    // structural sharing 은 내용이 바뀐 배열을 새로 복사한다. 점검을 사이에 부르지 않는다(앱에서처럼).
    mockFetch.mockImplementation(async (input) => jsonResponse([{ symbol: String(input), name: `name ${String(input)}` }]));
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    findQueryClients();
    await client.fetchQuery({ queryKey: ['search'], queryFn: load('/api/search?q=aapl'), staleTime: 0 });
    await client.fetchQuery({ queryKey: ['search'], queryFn: load('/api/search?q=msft'), staleTime: 0 });
    const found = audit(sameOrOk, getRecords()).find((f) => f.kind === 'key-missing-param');
    expect(found?.requests).toEqual(['GET /api/search?q=aapl', 'GET /api/search?q=msft']);
  });

  it('본문이 다른 POST 는 다른 요청으로, 읽을 수 없는 본문은 점검에서 뺀다', async () => {
    // 조회마다 다른 데이터(같으면 structural sharing 이 이전 객체를 그대로 둔다)
    mockFetch.mockImplementation(async (_input, init) => jsonResponse({ query: String(init?.body ?? 'stream'), size: 20, total: 100 }));
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    findQueryClients();
    const post = (body: string) => () => fetch('/api/graphql', { method: 'POST', body }).then((r) => r.json());
    await client.fetchQuery({ queryKey: ['gql'], queryFn: post('{"q":1}') });
    await client.fetchQuery({ queryKey: ['gql'], queryFn: post('{"q":2}') });
    // Request 객체의 본문은 읽을 수 없다. 키를 제대로 나눴어도 같은 요청으로 보이면 안 된다.
    const unreadable = (q: number) => () =>
      fetch(new Request('http://localhost/api/search', { method: 'POST', body: `{"q":${q}}` })).then((r) => r.json());
    await client.fetchQuery({ queryKey: ['search', 1], queryFn: unreadable(1) });
    await client.fetchQuery({ queryKey: ['search', 2], queryFn: unreadable(2) });
    const findings = audit(sameOrOk, getRecords());
    expect(findings.find((f) => f.kind === 'key-missing-param')?.requests).toEqual(['POST /api/graphql']);
    expect(findings.filter((f) => f.kind === 'duplicate-cache')).toEqual([]);
  });

  it('setQueryData 로 직접 넣은 데이터는 요청으로 세지 않는다(수정 응답으로 캐시를 갱신하는 정상 패턴)', async () => {
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    await client.fetchQuery({ queryKey: ['todo', 1], queryFn: load('/api/todos/1') });
    audit(sameOrOk, getRecords());
    mockFetch.mockImplementationOnce(async () => jsonResponse({ id: 1, title: 'updated', done: true }));
    const updated = await fetch('/api/todos/1', { method: 'PUT', body: '{}' }).then((r) => r.json());
    client.setQueryData(['todo', 1], updated);
    expect(audit(sameOrOk, getRecords()).filter((f) => f.kind === 'key-missing-param')).toEqual([]);
  });

  it('지금은 없어도(GC 등) 이 화면에서 만든 적 있는 키를 무효화하면 미스가 아니다', async () => {
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    findQueryClients();
    await client.fetchQuery({ queryKey: ['reports', 7], queryFn: load('/api/reports/7') });
    client.removeQueries({ queryKey: ['reports'] });
    await client.invalidateQueries({ queryKey: ['reports'] });
    expect(audit(sameOrOk, getRecords()).filter((f) => f.kind === 'invalidate-miss')).toEqual([]);
  });

  it('객체 요소는 무효화 쪽 필드만 같으면 맞는다(react-query 의 부분 일치, 키 순서 무시)', async () => {
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    findQueryClients();
    await client.fetchQuery({ queryKey: ['todos', { status: 'done', page: 1 }], queryFn: load('/api/todos?status=done&page=1') });
    await client.invalidateQueries({ queryKey: ['todos', { status: 'done' }] });
    await client.invalidateQueries({ queryKey: ['todos', { page: 1, status: 'done' }] });
    await client.invalidateQueries({ queryKey: ['todos', { status: 'open' }] });
    expect(
      audit(sameOrOk, getRecords())
        .filter((f) => f.kind === 'invalidate-miss')
        .map((f) => f.keys[0]),
    ).toEqual(['["todos",{"status":"open"}]']);
  });

  it('무효화한 키와 맞는 쿼리가 없으면 부른 위치와 함께 알리고, 무효화는 그대로 한다', async () => {
    const client = new QueryClient();
    withClient(client, <p>app</p>);
    await client.fetchQuery({ queryKey: ['todos', 1], queryFn: load('/api/todos/1') });
    expect(findQueryClients()).toContain(client);
    await client.invalidateQueries({ queryKey: ['todo'] });
    await client.invalidateQueries({ queryKey: ['todos'] });
    const misses = audit(sameOrOk, getRecords()).filter((f) => f.kind === 'invalidate-miss');
    expect(misses.map((f) => f.keys[0])).toEqual(['["todo"]']);
    expect(misses[0].stack).toContain('cacheAudit.test');
    // 첫 줄이 앱 코드다(rdx 가 감싼 프레임이 아니다).
    expect(misses[0].stack?.split('\n')[0]).toContain('cacheAudit.test');
    expect(misses[0].stack).not.toContain('recordInvalidate');
    expect(client.getQueryState(['todos', 1])?.isInvalidated).toBe(true);
  });

  it('staleTime 0 인 쿼리가 2초 안에(중복으로 분류) 같은 응답을 다시 받아도 알린다', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ same: true }));
    const client = new QueryClient();
    const View = () => <p>{useQuery({ queryKey: ['config'], queryFn: load('/api/config') }).data ? 'ready' : ''}</p>;
    withClient(client, <View />);
    await screen.findByText('ready');
    await act(() => client.refetchQueries({ queryKey: ['config'] }));
    await act(flush);
    await waitFor(() => expect(getRecords().some((r) => r.sameResponseAs)).toBe(true));
    const dupOrOk = (r: RequestRecord): RequestClass => (r.sameResponseAs ? 'duplicate' : 'ok');
    expect(audit(dupOrOk, getRecords()).some((f) => f.kind === 'stale-zero')).toBe(true);
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
    expect(audit(sameOrOk, getRecords()).some((f) => f.kind === 'stale-zero')).toBe(true);
  });
});
