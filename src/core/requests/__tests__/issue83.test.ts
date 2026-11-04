import { describe, expect, it, vi } from 'vitest';

import { flushQueue } from '../../scheduler/idleQueue.js';
import { cacheBusterParams, requestKeyOf } from '../requestKey.js';
import { createRecord, keepResponseText } from '../store.js';

// #83: 캐시를 피하려고 현재 시각을 붙인 쿼리(?_t=…)는 같은 요청 판정에서 뺀다.
const NOW = 1_730_700_000_000;
const key = (url: string, startedAt = NOW) => requestKeyOf({ method: 'GET', url, startedAt });

describe('cache-buster 쿼리 (#83)', () => {
  it('값이 요청 시각(ms·초)인 파라미터만 다른 요청은 같은 요청이다', () => {
    expect(key(`/api/items?_t=${NOW}`)).toBe(key(`/api/items?_t=${NOW + 800}`, NOW + 800));
    expect(key(`/api/items?page=2&_=${NOW}`)).toBe(key(`/api/items?_=${NOW + 3}&page=2`, NOW + 5));
    expect(key(`/api/items?ts=${NOW / 1000}`)).toBe(key(`/api/items?ts=${NOW / 1000 + 1}`, NOW + 1000));
    expect(key(`/api/items?ts=${(NOW + 123) / 1000}`)).toBe(key('/api/items'));
  });

  it('시각이 아닌 값이 다르면 지금처럼 다른 요청이다', () => {
    expect(key('/api/items?_t=1')).not.toBe(key('/api/items?_t=2'));
    // 이름이 cache-buster 같아도 값이 요청 시각과 멀면 진짜 파라미터다.
    expect(key('/api/items?since=1600000000000')).not.toBe(key('/api/items?since=1600000001000'));
    expect(key(`/api/items?ts=${NOW}&page=1`)).not.toBe(key(`/api/items?ts=${NOW}&page=2`));
    // 요청 시각을 모르면 빼지 않는다.
    expect(requestKeyOf({ method: 'GET', url: `/a?_t=${NOW}` })).not.toBe(requestKeyOf({ method: 'GET', url: `/a?_t=${NOW + 1}` }));
  });

  it('같은 이름이라도 값이 시각이 아닌 짝은 남긴다', () => {
    expect(key(`/a?_t=${NOW}&_t=abc`)).toBe(key(`/a?_t=abc&_t=${NOW + 1}`, NOW + 1));
    expect(key(`/a?_t=${NOW}&_t=abc`)).not.toBe(key(`/a?_t=${NOW}&_t=def`));
  });

  it('폴링의 since=<직전 조회 시각> 은 요청 시각과 2초 넘게 떨어져 있어 키에 남는다', () => {
    // 5초 주기 폴링: 매번 직전 조회 시각을 보낸다. 조건이 다르므로 다른 요청이다.
    expect(key(`/api/feed?since=${NOW - 5000}`)).not.toBe(key(`/api/feed?since=${NOW}`, NOW + 5000));
    expect(cacheBusterParams({ url: `/api/feed?since=${NOW - 2500}`, startedAt: NOW })).toEqual([]);
    expect(cacheBusterParams({ url: `/api/feed?_t=${NOW - 1500}`, startedAt: NOW })).toEqual(['_t']);
  });

  it('뺀 파라미터 이름을 알려 준다', () => {
    expect(cacheBusterParams({ url: `/a?_t=${NOW}&_t=${NOW + 1}`, startedAt: NOW })).toEqual(['_t']);
    expect(cacheBusterParams({ url: 'http://[bad', startedAt: NOW })).toEqual([]);
    expect(cacheBusterParams({ url: `/a?_t=${NOW}&page=2&_=${NOW / 1000}`, startedAt: NOW })).toEqual(['_t', '_']);
    expect(cacheBusterParams({ url: '/a?page=2', startedAt: NOW })).toEqual([]);
    expect(cacheBusterParams({ url: `/a?_t=${NOW}` })).toEqual([]);
  });

  it('Date.now() 를 붙인 같은 요청이 중복·같은 응답으로 잡힌다', () => {
    vi.useFakeTimers({ now: NOW });
    const a = createRecord('fetch', 'GET', `/api/cb?_t=${Date.now()}`);
    vi.advanceTimersByTime(500);
    const b = createRecord('fetch', 'GET', `/api/cb?_t=${Date.now()}`);
    vi.useRealTimers();
    keepResponseText(a, '[1]', { compare: true });
    keepResponseText(b, '[1]', { compare: true });
    flushQueue();
    expect(b.duplicateOf).toBe(a.id);
    expect(b.sameResponseAs).toBe(a.id);
  });
});
