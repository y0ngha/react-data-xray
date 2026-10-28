import { describe, expect, it } from 'vitest';

import { MAX_NODES_PER_BODY } from '../../../shared/limits.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getOrigin, registerOrigins } from '../origins.js';
import { createRecord } from '../store.js';

describe('출처 등록', () => {
  it('큰 응답은 나머지를 미뤄 등록해도, 조회하면 끝까지 찾고 먼저 받은 응답이 처음 출처로 남는다', () => {
    const shared = { id: 'shared' };
    const big = { list: Array.from({ length: 20_000 }, (_, i) => ({ id: i })), tail: shared };
    const first = createRecord('fetch', 'GET', '/api/big');
    const second = createRecord('fetch', 'GET', '/api/small');
    registerOrigins(first, big);
    registerOrigins(second, { again: shared });
    flushQueue();
    expect(getOrigin(big.list[19_999])).toEqual({ record: first, path: '$.list[19999]' });
    expect(getOrigin(shared)).toEqual({ record: first, path: '$.tail' });
  });

  it('한 응답 안에 같은 객체가 두 번 나오면 앞의 경로가 출처다', () => {
    const item = { name: 'a' };
    const record = createRecord('fetch', 'GET', '/api/dup-ref');
    registerOrigins(record, { a: [item], b: item });
    flushQueue();
    expect(getOrigin(item)?.path).toBe('$.a[0]');
  });

  it('register_is_deferred: 등록 직후엔 루트도 비어 있고 flushQueue 뒤에 등록된다', () => {
    const body = { a: { b: 1 } };
    const record = createRecord('fetch', 'GET', '/api/deferred');
    registerOrigins(record, body);
    expect(getOrigin(body)).toBeUndefined();
    expect(getOrigin(body.a)).toBeUndefined();
    flushQueue();
    expect(getOrigin(body.a)).toEqual({ record, path: '$.a' });
  });

  it('first_origin_wins_fifo: 먼저 넣은 응답의 경로가 출처다', () => {
    const shared = { id: 1 };
    const first = createRecord('fetch', 'GET', '/api/fifo-1');
    const second = createRecord('fetch', 'GET', '/api/fifo-2');
    registerOrigins(first, { x: shared });
    registerOrigins(second, { y: shared });
    flushQueue();
    expect(getOrigin(shared)).toEqual({ record: first, path: '$.x' });
  });

  it('node_cap: MAX_NODES_PER_BODY 를 넘는 노드는 등록하지 않는다', () => {
    const list = Array.from({ length: MAX_NODES_PER_BODY + 10 }, () => ({}));
    registerOrigins(createRecord('fetch', 'GET', '/api/cap'), list);
    flushQueue();
    expect(getOrigin(list[100])).toBeDefined();
    expect(getOrigin(list[list.length - 1])).toBeUndefined();
  });
});
