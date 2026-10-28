import { describe, expect, it } from 'vitest';

import { createRecord, finishRecord, registerBody } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { findDerivedOrigin, isIndexPending } from '../derivedMatch.js';

describe('파생 매칭 색인의 규모', () => {
  it('큰 응답은 나눠서 색인해 조회가 메인 스레드를 오래 막지 않고, 4ms 조각만으로 끝까지 색인한다', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: 10_000 + i, status: 'ACTIVE', type: 'webcheck' }));
    const record = createRecord('fetch', 'GET', '/api/big-list');
    finishRecord(record, 200);
    registerBody(record, { rows });
    const started = performance.now();
    findDerivedOrigin({ id: 10_123, status: 'ACTIVE', label: 'x' });
    // 한 번에 색인하면 수백 ms 가 걸린다. 조회는 색인 일을 큐에 올리기만 하고 돌아온다.
    expect(performance.now() - started).toBeLessThan(100);
    expect(isIndexPending()).toBe(true);
    // 배경 구동이 하듯 4ms 조각을 되풀이한다(실제 시간에 기대면 느린 CI 에서 시간 안에 못 끝낸다).
    // 목록을 매번 복사하던 코드(제곱 시간)는 이 크기에서 수십 초가 걸려 조각 수가 상한을 넘는다.
    for (let i = 0; i < 10_000 && isIndexPending(); i++) flushQueue(4);
    expect(isIndexPending()).toBe(false);
    expect(findDerivedOrigin({ id: 10_123, status: 'ACTIVE', label: 'x' })?.path).toBe('$.rows[123]');
  });

  it('요소 클릭처럼 한 번 묻는 조회는 남은 색인을 다 하고 바로 찾는다', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: 50_000 + i, status: 'ACTIVE', type: 'webcheck' }));
    const record = createRecord('fetch', 'GET', '/api/big-list-2');
    finishRecord(record, 200);
    registerBody(record, { rows });
    findDerivedOrigin({ id: 50_001, status: 'ACTIVE' });
    expect(isIndexPending()).toBe(true);
    flushQueue(); // flushIndex 는 200ms 까지만 해서 부하가 크면 남을 수 있다
    expect(isIndexPending()).toBe(false);
    expect(findDerivedOrigin({ id: 59_999, status: 'ACTIVE', label: 'y' })?.path).toBe('$.rows[9999]');
  });
});
