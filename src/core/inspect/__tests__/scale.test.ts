import { describe, expect, it } from 'vitest';

import { createRecord, finishRecord, registerBody } from '../../requests/store.js';
import { findDerivedOrigin } from '../derivedMatch.js';

describe('파생 매칭 색인의 규모', () => {
  it('같은 값이 수만 번 나오는 큰 응답도 색인을 빠르게 만든다(리뷰에서 찾은 제곱 시간 회귀)', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: 10_000 + i, status: 'ACTIVE', type: 'webcheck' }));
    const record = createRecord('fetch', 'GET', '/api/big-list');
    finishRecord(record, 200);
    registerBody(record, { rows });
    const started = performance.now();
    const origin = findDerivedOrigin({ id: 10_123, status: 'ACTIVE', label: 'x' });
    // 목록을 매번 복사하던 코드는 이 크기에서 수십 초가 걸린다.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(origin?.path).toBe('$.rows[123]');
  });
});
