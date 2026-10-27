import { describe, expect, it } from 'vitest';

import { installSessionRecords, saveRecords } from '../sessionRecords.js';
import { clearRecords, createRecord, finishRecord, getRecords, keepResponseText, registerBody } from '../store.js';

const KEY = 'react-data-xray:records';

describe('탭 안에서 요청 기록 이어 가기', () => {
  it('새로고침 전 기록을 되살리되 응답 객체는 빼고 인증 헤더는 가리며, 새 요청은 그 뒤 번호를 받는다', () => {
    const record = createRecord('fetch', 'GET', '/api/users');
    record.requestHeaders = { authorization: 'Bearer secret', accept: 'application/json' };
    finishRecord(record, 200);
    keepResponseText(record, '{"users":[1]}', { compare: true });
    registerBody(record, { users: [1] });
    saveRecords();

    // 새로고침: 메모리는 비고 sessionStorage 만 남는다.
    clearRecords();
    installSessionRecords();
    const [restored] = getRecords();
    expect(restored).toMatchObject({ url: '/api/users', restored: true, responseText: '{"users":[1]}' });
    expect(restored.body).toBeUndefined();
    expect(restored.requestHeaders).toEqual({ authorization: '(가림)', accept: 'application/json' });
    const next = createRecord('fetch', 'GET', '/api/users');
    expect(next.id).toBeGreaterThan(restored.id);
    // 새로고침 직후 다시 나간 같은 요청을 중복으로 찍지 않는다.
    expect(next.duplicateOf).toBeUndefined();
  });

  it('저장소 용량을 넘기지 않게 오래된 기록부터 버린다', () => {
    const big = 'x'.repeat(90_000);
    Array.from({ length: 40 }, (_, i) => {
      const r = createRecord('fetch', 'GET', `/api/big/${i}`);
      finishRecord(r, 200);
      keepResponseText(r, big, { compare: false });
      return r;
    });
    saveRecords();
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as Array<{ url: string }>;
    expect(sessionStorage.getItem(KEY)!.length).toBeLessThanOrEqual(2_000_000);
    expect(saved.length).toBeLessThan(40);
    expect(saved.at(-1)?.url).toBe('/api/big/39');
  });
});
