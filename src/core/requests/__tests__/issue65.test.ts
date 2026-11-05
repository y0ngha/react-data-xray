import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { sameResponseMemory } from '../repeatDetection.js';
import { createResponseHasher, digestOf, HASH_CHUNK, sameDigest } from '../responseHash.js';
import { clearRecords, createRecord, keepResponseText } from '../store.js';

const MB = 1_000_000;
const big = (tail: string) => `${'{"rows":['.padEnd(MB, '1,')}${tail}]}`;

const respond = (url: string, text: string, requestBody?: string | null) => {
  const record = createRecord('fetch', 'GET', url, requestBody);
  keepResponseText(record, text, { compare: true });
  return record;
};

/** 큐의 step 을 한 번씩만 부른다(flushQueue(0) 은 step 하나를 부르고 멈춘다). */
const runSteps = (n: number) => {
  for (let i = 0; i < n; i++) flushQueue(0);
};

// 다른 모듈이 불러올 때 넣은 일을 먼저 비워, step 수를 세는 테스트가 이 테스트의 일만 보게 한다.
beforeEach(() => {
  flushQueue();
});

afterEach(() => {
  flushQueue();
  clearRecords();
});

describe('이슈 65: 같은 응답 판정이 응답 원문을 들고 있지 않는다', () => {
  it('1MB 응답도 같으면 같은 응답, 끝 한 글자만 달라도 다른 응답이다', () => {
    const a = respond('/api/big', big('0'));
    const b = respond('/api/big', big('0'));
    const c = respond('/api/big', big('1')); // 앞 1MB 가 같아도 다르다(앞부분만 잘라 비교하지 않는다)
    flushQueue();
    expect(b.sameResponseAs).toBe(a.id);
    expect(c.sameResponseAs).toBeUndefined();
  });

  it('큰 응답의 해시가 끝나기 전에는 뒤의 판정이 돌지 않는다', () => {
    const a = respond('/api/order', big('0')); // 중복 판정, 원문 보관, 해시(여러 조각)
    const b = respond('/api/order', 'small'); // 중복 판정, 원문 보관 + 판정
    const c = respond('/api/order', 'small');
    // 해시가 뒤를 막지 않는다면 이 안에 b, c 의 step 이 모두 돈다(앞의 둘 + 해시 한 조각 + 뒤의 넷 = 7).
    runSteps(12);
    expect(a.responseText).toBeDefined(); // 원문 보관은 끝났고
    expect(isQueuePending()).toBe(true); // a 의 해시는 아직 도는 중이다
    expect(b.responseText).toBeUndefined();
    expect(c.sameResponseAs).toBeUndefined();
    flushQueue();
    expect(a.sameResponseAs).toBeUndefined();
    expect(b.sameResponseAs).toBeUndefined();
    expect(c.sameResponseAs).toBe(b.id);
  });

  it('한 조각 이하의 응답은 원문 보관 step 에서 바로 판정한다', () => {
    const a = respond('/api/short', 'x'.repeat(HASH_CHUNK));
    const b = respond('/api/short', 'x'.repeat(HASH_CHUNK));
    runSteps(4); // 요청마다 중복 판정 + 원문 보관
    expect(b.sameResponseAs).toBe(a.id);
  });

  it('payload 를 모르는 요청은 해시하지 않는다', () => {
    const r = respond('/api/up', big('0'), null);
    runSteps(4); // 중복 판정, 원문 보관, 워터폴 판정, 그 알림뿐
    expect(isQueuePending()).toBe(false);
    expect(r.sameResponseAs).toBeUndefined();
    expect(sameResponseMemory().keys).toBe(0);
  });

  it('키마다 남는 값은 원문이 아니라 길이와 해시다', () => {
    for (let page = 1; page <= 20; page++) respond(`/api/list?page=${page}`, big(String(page)));
    flushQueue();
    expect(sameResponseMemory()).toEqual({ keys: 20, retainedChars: 0 });
  });

  it('해시가 끝나기 전에는 지문을 내주지 않는다', () => {
    const hasher = createResponseHasher(big('0'));
    expect(() => hasher.digest()).toThrow('not finished');
    hasher.step();
    expect(() => hasher.digest()).toThrow('not finished'); // 앞부분 지문에 전체 길이를 붙이지 않는다
    while (!hasher.step());
    expect(sameDigest(hasher.digest(), digestOf(big('0')))).toBe(true);
  });

  it('길이가 같고 내용이 다른 응답은 지문이 다르다', () => {
    expect(sameDigest(digestOf('ab'), digestOf('ba'))).toBe(false);
    expect(sameDigest(digestOf(''), digestOf(''))).toBe(true);
    expect(sameDigest(digestOf('a'), digestOf('a\u0000'))).toBe(false);
    // 한 갈래만 비교하면 겹치는 경우가 생겨도, 두 갈래가 함께 같을 일은 없다(작은 표본에서 64비트 전체가 겹치지 않는다).
    const seen = new Set(Array.from({ length: 5000 }, (_, i) => digestOf(`{"id":${i}}`)).map((d) => `${d.hi}:${d.lo}`));
    expect(seen.size).toBe(5000);
  });
});
