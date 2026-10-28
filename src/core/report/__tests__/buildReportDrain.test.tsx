import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { findQueryClients } from '../../reactQuery/cacheAudit.js';
import { jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { buildReport } from '../buildReport.js';

describe('보고서의 큐 비우기', () => {
  it('buildReport_flushes_index: 방금 받은 복사본 데이터도 조회 없이 보고서에서 출처를 찾는다', async () => {
    mockFetch.mockImplementation(async (input) => jsonResponse([{ symbol: String(input), name: `name ${String(input)}` }]));
    const queryFn = (url: string) => () =>
      fetch(url)
        .then((r) => r.json())
        .then((j) => structuredClone(j)); // 같은 참조가 아니라 필드 값으로만 찾는다
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <p>app</p>
      </QueryClientProvider>,
    );
    findQueryClients(); // 성공 이벤트를 받으려면 먼저 감시해야 한다
    await client.fetchQuery({ queryKey: ['a'], queryFn: queryFn('/api/list?page=1') });
    await client.fetchQuery({ queryKey: ['a'], queryFn: queryFn('/api/list?page=2') });
    expect(buildReport(true).reactQuery.findings.some((f) => f.kind === 'key-missing-param')).toBe(true);
  });
});
