import { describe, expect, it } from 'vitest';

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
    expect(getOrigin(big.list[19_999])).toEqual({ record: first, path: '$.list[19999]' });
    expect(getOrigin(shared)).toEqual({ record: first, path: '$.tail' });
  });

  it('한 응답 안에 같은 객체가 두 번 나오면 앞의 경로가 출처다', () => {
    const item = { name: 'a' };
    const record = createRecord('fetch', 'GET', '/api/dup-ref');
    registerOrigins(record, { a: [item], b: item });
    expect(getOrigin(item)?.path).toBe('$.a[0]');
  });
});
