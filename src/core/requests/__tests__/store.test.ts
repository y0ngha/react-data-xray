import { describe, expect, it, vi } from 'vitest';

import { getOrigin } from '../origins.js';
import {
  clearRecords,
  createRecord,
  finishRecord,
  getBodyVersion,
  getRecords,
  keepResponseText,
  registerBody,
  subscribe,
} from '../store.js';

describe('store', () => {
  it('2초 안의 같은 요청은 앞선 요청의 중복으로 표시하고, 2초가 지나면 아니다', () => {
    vi.useFakeTimers();
    const a = createRecord('fetch', 'get', '/api/x');
    const b = createRecord('fetch', 'GET', '/api/x');
    vi.advanceTimersByTime(2500);
    const c = createRecord('fetch', 'GET', '/api/x');
    vi.useRealTimers();
    expect(a.method).toBe('GET');
    expect(b.duplicateOf).toBe(a.id);
    expect(c.duplicateOf).toBeUndefined();
  });

  it('읽을 수 없는 payload 는 중복·같은 응답 판정에서 뺀다', () => {
    const a = createRecord('fetch', 'POST', '/api/up', null);
    const b = createRecord('fetch', 'POST', '/api/up', null);
    keepResponseText(a, 'same', { compare: true });
    keepResponseText(b, 'same', { compare: true });
    expect(b.bodyUnreadable).toBe(true);
    expect(b.duplicateOf).toBeUndefined();
    expect(b.sameResponseAs).toBeUndefined();
  });

  it('직전과 같은 응답이면 같은 응답 재요청, 비교하지 않기로 한 응답은 표시하지 않는다', () => {
    const a = createRecord('fetch', 'GET', '/api/s');
    keepResponseText(a, '{"v":1}', { compare: true });
    const b = createRecord('fetch', 'GET', '/api/s');
    keepResponseText(b, '{"v":1}', { compare: true });
    const c = createRecord('fetch', 'GET', '/api/s');
    keepResponseText(c, '{"v":1}', { compare: false });
    expect(b.sameResponseAs).toBe(a.id);
    expect(c.sameResponseAs).toBeUndefined();
  });

  it('100KB 가 넘는 응답 원문은 잘라서 보관한다', () => {
    const r = createRecord('fetch', 'GET', '/api/big');
    keepResponseText(r, 'x'.repeat(100_001), { compare: false });
    expect(r.responseText).toHaveLength(100_000 + '\n… (100KB 이후 생략)'.length);
  });

  it('응답 본문의 객체를 출처와 함께 등록하고, 같은 응답이 두 번 들어와도 한 번만 등록한다', () => {
    const r = createRecord('fetch', 'GET', '/api/b');
    const body = { list: [{ id: 1 }] };
    const before = getBodyVersion();
    registerBody(r, body);
    registerBody(r, { other: true });
    expect(getBodyVersion()).toBe(before + 1);
    expect(r.body).toBe(body);
    expect(getOrigin(body.list[0])).toEqual({ record: r, path: '$.list[0]' });
  });

  it('요청 목록은 최근 200건만 남기고, 바뀔 때마다 구독자에게 알린다', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);
    Array.from({ length: 205 }, (_, i) => finishRecord(createRecord('fetch', 'GET', `/api/${i}`), 200));
    unsubscribe();
    expect(getRecords()).toHaveLength(200);
    expect(getRecords()[0].url).toBe('/api/5');
    expect(listener).toHaveBeenCalledTimes(205);
    clearRecords();
    expect(getRecords()).toHaveLength(0);
  });

  it('실패한 요청은 상태 0 과 에러로 기록한다', () => {
    const r = createRecord('xhr', 'GET', '/api/fail');
    finishRecord(r, 0, 'abort');
    expect(getRecords()[0]).toMatchObject({ status: 0, error: 'abort', kind: 'xhr' });
  });
});
