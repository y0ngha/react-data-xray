import { describe, expect, it, vi } from 'vitest';

import { annotateRequest } from '../../capture/requestContext.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getOrigin } from '../origins.js';
import {
  clearRecords,
  createRecord,
  finishRecord,
  getDroppedCount,
  getRecords,
  getStoreVersion,
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
    flushQueue();
    expect(a.method).toBe('GET');
    expect(b.duplicateOf).toBe(a.id);
    expect(c.duplicateOf).toBeUndefined();
  });

  it('읽을 수 없는 payload 는 중복·같은 응답 판정에서 뺀다', () => {
    const a = createRecord('fetch', 'POST', '/api/up', null);
    const b = createRecord('fetch', 'POST', '/api/up', null);
    keepResponseText(a, 'same', { compare: true });
    keepResponseText(b, 'same', { compare: true });
    flushQueue();
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
    flushQueue();
    expect(b.sameResponseAs).toBe(a.id);
    expect(c.sameResponseAs).toBeUndefined();
  });

  it('100KB 가 넘는 응답 원문은 잘라서 보관한다', () => {
    const r = createRecord('fetch', 'GET', '/api/big');
    keepResponseText(r, 'x'.repeat(100_001), { compare: false });
    flushQueue();
    expect(r.responseText).toHaveLength(100_000 + '\n… (100KB 이후 생략)'.length);
  });

  it('응답 본문의 객체를 출처와 함께 등록하고, 같은 응답이 두 번 들어와도 한 번만 등록한다', () => {
    const r = createRecord('fetch', 'GET', '/api/b');
    const body = { list: [{ id: 1 }] };
    registerBody(r, body);
    registerBody(r, { other: true });
    flushQueue();
    expect(r.body).toBe(body);
    expect(getOrigin(body.list[0])).toEqual({ record: r, path: '$.list[0]' });
  });

  it('요청 목록은 최근 200건만 남기고, 바뀐 뒤 구독자에게 한 번에 알린다', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);
    Array.from({ length: 205 }, (_, i) => finishRecord(createRecord('fetch', 'GET', `/api/${i}`), 200));
    flushQueue();
    unsubscribe();
    expect(getRecords()).toHaveLength(200);
    expect(getRecords()[0].url).toBe('/api/5');
    expect(listener).toHaveBeenCalledTimes(1);
    clearRecords();
    expect(getRecords()).toHaveLength(0);
  });

  it('측정을 새로 시작하기 전에 나간 요청은 늦게 끝나도 새 기록에 넣지 않는다', () => {
    const inFlight = createRecord('fetch', 'GET', '/api/poll');
    clearRecords();
    finishRecord(inFlight, 200);
    const fresh = createRecord('fetch', 'GET', '/api/poll');
    finishRecord(fresh, 200);
    expect(getRecords()).toEqual([fresh]);
  });

  it('측정 전 요청의 늦은 응답은 같은 응답 판정과 출처 등록에도 쓰지 않는다', () => {
    const inFlight = createRecord('fetch', 'GET', '/api/late');
    clearRecords();
    keepResponseText(inFlight, '{"a":1}', { compare: true });
    const body = { a: 1 };
    registerBody(inFlight, body);
    expect(getOrigin(body)).toBeUndefined();
    const fresh = createRecord('fetch', 'GET', '/api/late');
    keepResponseText(fresh, '{"a":1}', { compare: true });
    flushQueue();
    expect(fresh.sameResponseAs).toBeUndefined();
  });

  it('기록 상한을 넘어 버린 요청 수를 세고, 측정을 새로 시작하면 0 으로 돌린다', () => {
    clearRecords();
    Array.from({ length: 205 }, (_, i) => finishRecord(createRecord('fetch', 'GET', `/api/n${i}`), 200));
    expect(getDroppedCount()).toBe(5);
    clearRecords();
    expect(getDroppedCount()).toBe(0);
  });

  it('실패한 요청은 상태 0 과 에러로 기록한다', () => {
    const r = createRecord('xhr', 'GET', '/api/fail');
    finishRecord(r, 0, 'abort');
    expect(getRecords()[0]).toMatchObject({ status: 0, error: 'abort', kind: 'xhr' });
  });

  it('URL 이 매번 다른 요청이 많아도 같은 응답 판정용 기록은 상한까지만 남긴다', () => {
    const respond = (url: string) => {
      const r = createRecord('fetch', 'GET', url);
      finishRecord(r, 200);
      keepResponseText(r, '{"same":true}', { compare: true });
      flushQueue();
      return r;
    };
    respond('/api/first');
    Array.from({ length: 600 }, (_, i) => respond(`/api/poll?_t=${i}`));
    // 첫 키는 밀려나 비교 대상이 없다.
    expect(respond('/api/first').sameResponseAs).toBeUndefined();
    expect(respond('/api/first').sameResponseAs).toBeDefined();
  });

  it('duplicate_after_flush: 중복 판정은 큐에서 한다', () => {
    const a = createRecord('fetch', 'GET', '/api/dup');
    const b = createRecord('fetch', 'GET', '/api/dup');
    expect(b.duplicateOf).toBeUndefined();
    flushQueue();
    expect(b.duplicateOf).toBe(a.id);
  });

  it('notify_deferred: 버전은 즉시 오르고 구독자는 flush 뒤 한 번 불린다', () => {
    flushQueue();
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribe(listener);
    const before = getStoreVersion();
    finishRecord(createRecord('fetch', 'GET', '/api/n1'), 200);
    expect(listener).not.toHaveBeenCalled();
    expect(getStoreVersion()).toBe(before + 1);
    finishRecord(createRecord('fetch', 'GET', '/api/n2'), 200);
    flushQueue();
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('same_response_after_flush: 같은 원문 두 번은 flush 뒤 첫 id 를 가리킨다', () => {
    const a = createRecord('fetch', 'GET', '/api/same');
    const b = createRecord('fetch', 'GET', '/api/same');
    keepResponseText(a, 'x', { compare: true });
    keepResponseText(b, 'x', { compare: true });
    expect(b.sameResponseAs).toBeUndefined();
    flushQueue();
    expect(b.sameResponseAs).toBe(a.id);
  });

  it('stale_record_skipped: clearRecords 뒤 처리되는 step 은 이전 기록을 건드리지 않는다', () => {
    const r = createRecord('fetch', 'GET', '/api/stale');
    keepResponseText(r, 'x', { compare: true });
    clearRecords();
    flushQueue();
    expect(r.responseText).toBeUndefined();
    expect(r.duplicateOf).toBeUndefined();
  });

  it('stack_deferred: 스택 문자열은 flush 뒤에 생긴다', () => {
    const r = annotateRequest(createRecord('fetch', 'GET', '/api/stack'));
    expect(r.stack).toBeUndefined();
    flushQueue();
    expect(r.stack).toContain('store.test');
  });
});
