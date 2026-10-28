import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { auditQueryCache, findQueryClients } from '../cacheAudit.js';

const setup = async () => {
  mockFetch.mockImplementation(async () => jsonResponse({ ok: true }));
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <p>app</p>
    </QueryClientProvider>,
  );
  findQueryClients();
  await client.fetchQuery({ queryKey: ['member', 'list', 'ws', 'P', 1], queryFn: () => fetch('/api/x').then((r) => r.json()) });
  return client;
};
const audit = () => {
  flushQueue();
  return auditQueryCache(() => 'ok', getRecords());
};

describe('이슈 34: 겹친 무효화', () => {
  it('narrow_plus_def: 좁은 키 + 넓은 키를 함께 부르면 double-invalidate 와 두 호출 위치', async () => {
    const client = await setup();
    const narrow = () => client.invalidateQueries({ queryKey: ['member', 'list', 'ws', 'P'] });
    const def = () => client.invalidateQueries({ queryKey: ['member', 'list'] });
    await Promise.all([narrow(), def()]);
    await flush();
    const found = audit().filter((f) => f.kind === 'double-invalidate');
    expect(found).toHaveLength(1);
    expect(found[0].keys).toEqual(['["member","list","ws","P"]', '["member","list"]']);
    expect(found[0].stacks).toHaveLength(2);
    expect(found[0].stacks?.every((s) => s.length > 0)).toBe(true);
  });

  it('서로 다른 쿼리를 덮는 두 무효화는 기록하지 않는다', async () => {
    const client = await setup();
    await client.invalidateQueries({ queryKey: ['member', 'list', 'ws', 'P'] });
    await client.invalidateQueries({ queryKey: ['other'] });
    expect(audit().filter((f) => f.kind === 'double-invalidate')).toHaveLength(0);
  });

  it('래퍼는 동기로 partialMatch 를 돌지 않는다: 아는 키를 읽지 않고 flushQueue 뒤에야 판정한다', async () => {
    const client = await setup();
    const narrow = client.invalidateQueries({ queryKey: ['member', 'list', 'ws', 'P'] });
    const def = client.invalidateQueries({ queryKey: ['member', 'list'] });
    // 아직 큐를 비우지 않았으므로 판정(misses)은 비어 있어야 한다.
    expect(auditQueryCache(() => 'ok', getRecords()).filter((f) => f.kind === 'double-invalidate')).toHaveLength(0);
    await Promise.all([narrow, def]);
    expect(audit().filter((f) => f.kind === 'double-invalidate')).toHaveLength(1);
  });
});
