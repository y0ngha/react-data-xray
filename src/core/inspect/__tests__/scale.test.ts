import { describe, expect, it, vi } from 'vitest';

import { createRecord, finishRecord, registerBody } from '../../requests/store.js';
import { findDerivedOrigin } from '../derivedMatch.js';

describe('파생 매칭 색인의 규모', () => {
  it('큰 응답은 나눠서 색인해 조회가 메인 스레드를 오래 막지 않고, 끝나면 찾는다', async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: 10_000 + i, status: 'ACTIVE', type: 'webcheck' }));
    const record = createRecord('fetch', 'GET', '/api/big-list');
    finishRecord(record, 200);
    registerBody(record, { rows });
    const started = performance.now();
    findDerivedOrigin({ id: 10_123, status: 'ACTIVE', label: 'x' });
    // 한 번에 색인하면 수백 ms 가 걸린다. 지금은 8ms 조각 하나만 하고 돌아온다.
    expect(performance.now() - started).toBeLessThan(100);
    // 목록을 매번 복사하던 코드(제곱 시간)는 이 크기에서 수십 초가 걸린다.
    await vi.waitFor(() => expect(findDerivedOrigin({ id: 10_123, status: 'ACTIVE', label: 'x' })?.path).toBe('$.rows[123]'), {
      timeout: 2000,
    });
  });
});
