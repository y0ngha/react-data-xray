import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { auditQueryCache, findQueryClients } from '../cacheAudit.js';

const KEY = ['member', 'list', 'ws', 'P', 1];
const queryFn = () => fetch('/api/x').then((r) => r.json());
const Member = () => <p>{useQuery({ queryKey: KEY, queryFn, staleTime: 60_000 }).data ? 'loaded' : ''}</p>;

// active=true 면 useQuery 를 마운트한 활성 쿼리, false 면 관찰자 없는 비활성 쿼리
const setup = async (active = true) => {
  mockFetch.mockImplementation(async () => jsonResponse({ ok: true }));
  const client = new QueryClient();
  render(<QueryClientProvider client={client}>{active ? <Member /> : <p>app</p>}</QueryClientProvider>);
  findQueryClients();
  if (active) await screen.findByText('loaded');
  else await client.fetchQuery({ queryKey: KEY, queryFn });
  return client;
};
const audit = () => {
  flushQueue();
  return auditQueryCache(() => 'ok', getRecords());
};
const doubles = () => audit().filter((f) => f.kind === 'double-invalidate');

describe('이슈 34: 겹친 무효화', () => {
  it('narrow_plus_def: 좁은 키 + 넓은 키를 함께 부르면 double-invalidate 와 두 호출 위치', async () => {
    const client = await setup();
    const narrow = () => client.invalidateQueries({ queryKey: ['member', 'list', 'ws', 'P'] });
    const def = () => client.invalidateQueries({ queryKey: ['member', 'list'] });
    await Promise.all([narrow(), def()]);
    await flush();
    const found = doubles();
    expect(found).toHaveLength(1);
    expect(found[0].keys).toEqual(['["member","list","ws","P"]', '["member","list"]']);
    expect(found[0].stacks).toHaveLength(2);
    expect(found[0].stacks?.every((s) => s.length > 0)).toBe(true);
  });

  it('서로 다른 쿼리를 덮는 두 무효화는 기록하지 않는다', async () => {
    const client = await setup();
    await client.invalidateQueries({ queryKey: ['member', 'list', 'ws', 'P'] });
    await client.invalidateQueries({ queryKey: ['other'] });
    expect(doubles()).toHaveLength(0);
  });

  it('래퍼는 동기로 partialMatch 를 돌지 않는다: 아는 키를 읽지 않고 flushQueue 뒤에야 판정한다', async () => {
    const client = await setup();
    const narrow = client.invalidateQueries({
      queryKey: ['member', 'list', 'ws', 'P'],
    });
    const def = client.invalidateQueries({ queryKey: ['member', 'list'] });
    // 아직 큐를 비우지 않았으므로 판정(misses)은 비어 있어야 한다.
    expect(auditQueryCache(() => 'ok', getRecords()).filter((f) => f.kind === 'double-invalidate')).toHaveLength(0);
    await Promise.all([narrow, def]);
    expect(doubles()).toHaveLength(1);
  });

  it('관찰자 없는 비활성 쿼리는 다시 받지 않아 취소할 재조회가 없다', async () => {
    const client = await setup(false);
    await Promise.all([
      client.invalidateQueries({ queryKey: ['member', 'list', 'ws', 'P'] }),
      client.invalidateQueries({ queryKey: ['member', 'list'] }),
    ]);
    expect(doubles()).toHaveLength(0);
  });

  it('refetchType none 으로 표시만 한 무효화는 겹쳐도 기록하지 않는다', async () => {
    const client = await setup();
    await Promise.all([
      client.invalidateQueries({
        queryKey: ['member', 'list', 'ws', 'P'],
        refetchType: 'none',
      }),
      client.invalidateQueries({ queryKey: ['member', 'list'] }),
    ]);
    expect(doubles()).toHaveLength(0);
  });

  it('같은 두 호출 위치의 겹침은 키가 달라도 한 줄로 묶고 횟수를 센다', async () => {
    const client = await setup();
    const pair = (narrow: unknown[]) => [
      client.invalidateQueries({ queryKey: narrow }),
      client.invalidateQueries({ queryKey: ['member', 'list'] }),
    ];
    for (const narrow of [KEY, KEY.slice(0, 4), KEY.slice(0, 3)]) {
      await Promise.all(pair(narrow));
      await new Promise((r) => setTimeout(r, 60)); // 겹침 창(50ms) 밖으로 벌린다
    }
    const found = doubles();
    expect(found).toHaveLength(1);
    expect(found[0].count).toBe(3);
  });
});
