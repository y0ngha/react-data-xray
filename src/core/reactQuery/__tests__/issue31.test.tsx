import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { auditQueryCache, findQueryClients } from '../cacheAudit.js';

const setup = async (seen: unknown[][]) => {
  mockFetch.mockImplementation(async () => jsonResponse({ ok: true }));
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <p>app</p>
    </QueryClientProvider>,
  );
  findQueryClients();
  for (const queryKey of seen)
    await client.fetchQuery({
      queryKey,
      queryFn: () => fetch('/api/x').then((r) => r.json()),
    });
  return client;
};
const audit = () => {
  flushQueue();
  return auditQueryCache(() => 'ok', getRecords());
};

describe('이슈 31: 같은 키 모양이면 invalidate-miss 가 아니다', () => {
  it('shape_seen: 같은 모양의 다른 값 무효화는 invalidate-unloaded, 모양이 다르면 invalidate-miss', async () => {
    const client = await setup([['scopedMember', 'list', 3]]);
    await client.invalidateQueries({ queryKey: ['scopedMember', 'list', 7] });
    await client.invalidateQueries({ queryKey: ['other', 'list', 7] });
    await flush();
    const found = audit();
    expect(found.filter((f) => f.kind === 'invalidate-miss').map((f) => f.keys[0])).toEqual(['["other","list",7]']);
    expect(found.filter((f) => f.kind === 'invalidate-unloaded').map((f) => f.keys[0])).toEqual(['["scopedMember","list",7]']);
  });

  it('bulk_one_line: 같은 위치의 107키는 한 줄(count 107)', async () => {
    const client = await setup([['scopedMember', 'list', 'ws', 'GROUP', 1]]);
    const save = async () => {
      for (let i = 0; i < 107; i++)
        await client.invalidateQueries({
          queryKey: ['scopedMember', 'list', 'ws', 'PROJECT', i],
        });
    };
    await save();
    const unloaded = audit().filter((f) => f.kind === 'invalidate-unloaded');
    expect(unloaded).toHaveLength(1);
    expect(unloaded[0].count).toBe(107);
    expect(unloaded[0].keys.length).toBeLessThanOrEqual(3);
  });
});
