import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { classifyRecords } from '../../requests/classify.js';
import { getRecords } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { auditQueryCache, findQueryClients, refetchReason } from '../cacheAudit.js';

// 앞 테스트의 호출 횟수를 지우지 않게 원래 구현을 그대로 넘기되 센다.
const derived = vi.hoisted(() => ({ forceIdle: false }));
vi.mock('../../inspect/derivedMatch.js', async (original) => {
  const mod = await original<typeof import('../../inspect/derivedMatch.js')>();
  return {
    ...mod,
    isIndexPending: () => (derived.forceIdle ? false : mod.isIndexPending()),
  };
});

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
  const url = `/api/r4-${++n}`;
  const key = ['r4', n];
  const fetchOnce = (staleTime: number) =>
    client.fetchQuery({
      queryKey: key,
      staleTime,
      queryFn: () => fetch(url).then((r) => r.json()),
    });
  const lastRecord = () => [...getRecords()].reverse().find((r) => r.url === url)!;
  return { client, key, url, fetchOnce, lastRecord };
};

describe('PR4 검토: 키 모양', () => {
  it('shape_types: 뒤 원소의 타입이 어긋난 오타는 회색 unloaded 가 아니라 miss 다', async () => {
    const { client } = setup();
    await client.fetchQuery({
      queryKey: ['todo', 'detail', { id: 1 }],
      queryFn: () => fetch('/api/todo/1').then((r) => r.json()),
    });
    await client.invalidateQueries({ queryKey: ['todo', 'detail', 1] });
    await client.invalidateQueries({ queryKey: ['todo', 'detail', { id: 2 }] });
    flushQueue();
    const kinds = auditQueryCache(() => 'ok', getRecords()).filter((f) => f.kind.startsWith('invalidate-'));
    expect(kinds.map((f) => [f.keys[0], f.kind])).toEqual(
      expect.arrayContaining([
        ['["todo","detail",1]', 'invalidate-miss'],
        ['["todo","detail",{"id":2}]', 'invalidate-unloaded'],
      ]),
    );
  });
});

describe('PR4 검토: 재조회 원인', () => {
  it('failed_request: 실패·취소 요청은 쿼리 성공의 요청으로 맞추지 않는다', async () => {
    const { fetchOnce, lastRecord } = setup();
    await fetchOnce(20);
    await sleep(40);
    await fetchOnce(20);
    await flush();
    const r = lastRecord();
    expect(refetchReason(r)).toBe('stale-elapsed');
    expect(refetchReason({ ...r, status: 500 })).toBeUndefined();
    expect(refetchReason({ ...r, error: 'The operation was aborted' })).toBeUndefined();
  });

  it('fetch_start_state: 재조회 뒤 관찰자가 떨어져도 fetch 를 시작한 때의 staleTime 0 으로 판정한다', async () => {
    const { client, key, fetchOnce, lastRecord } = setup();
    const off = new QueryObserver(client, {
      queryKey: key,
      enabled: false,
      staleTime: 0,
      queryFn: () => null,
    }).subscribe(() => {});
    await fetchOnce(0);
    await sleep(5);
    await fetchOnce(0);
    off(); // 분류할 때는 관찰자가 없다
    await flush();
    expect(refetchReason(lastRecord())).toBe('stale-zero');
  });

  it('pinned_read: 분류는 유휴 큐가 고정하기 전에는 계산하지 않고, 고정된 뒤에 읽는다', async () => {
    const { fetchOnce, lastRecord } = setup();
    await fetchOnce(20);
    await sleep(40);
    await fetchOnce(20);
    const first = getRecords()
      .filter((r) => r.url.startsWith('/api/r4-'))
      .at(-2)!;
    const r = lastRecord();
    r.duplicateOf = undefined;
    r.sameResponseAs = first.id;
    // 방금 끝났고 유휴 큐가 아직 돌지 않았다: 분류가 이력을 훑지 않으니 아직 낭비로만 본다.
    expect(classifyRecords([first, r], new Set()).get(r.id)).toBe('same-response');
    flushQueue();
    r.duplicateOf = undefined; // 큐가 돌며 2초 안 중복으로 판정한 것을 되돌린다(실제 재조회는 2초 넘게 떨어져 있다)
    expect(classifyRecords([first, r], new Set()).get(r.id)).toBe('stale-elapsed');
  });
});

describe('PR4 검토: 출처 매칭 시도 횟수', () => {
  it('원인 조회는 점검의 출처 찾기 시도 횟수를 쓰지 않는다', async () => {
    const { client } = setup();
    mockFetch.mockImplementation(async (input) => jsonResponse([{ symbol: String(input), name: `name ${String(input)}` }]));
    const copy = (url: string) => () =>
      fetch(url)
        .then((r) => r.json())
        .then((j) => structuredClone(j));
    await client.fetchQuery({
      queryKey: ['rl'],
      queryFn: copy('/api/rl?page=1'),
    });
    await client.fetchQuery({
      queryKey: ['rl'],
      queryFn: copy('/api/rl?page=2'),
    });
    // 색인이 끝나지 않은 채로 여러 요청을 분류·조회해도(색인 대기를 세지 않는 상황을 흉내 낸다)
    derived.forceIdle = true;
    try {
      getRecords().forEach((r) => [1, 2, 3, 4].forEach(() => refetchReason(r)));
    } finally {
      derived.forceIdle = false;
    }
    flushQueue();
    // 지적이 사라지지 않는다.
    expect(auditQueryCache(() => 'ok', getRecords()).some((f) => f.kind === 'key-missing-param')).toBe(true);
  });
});
