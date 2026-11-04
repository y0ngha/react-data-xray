import { afterEach, describe, expect, it } from 'vitest';

import { flushQueue } from '../../scheduler/idleQueue.js';
import { responseMemoryForTest } from '../repeatDetection.js';
import { createResponseHasher, digestOf, sameDigest } from '../responseHash.js';
import { clearRecords, createRecord, keepResponseText } from '../store.js';

const MB = 1_000_000;
const big = (tail: string) => `${'{"rows":['.padEnd(MB, '1,')}${tail}]}`;

const respond = (url: string, text: string) => {
  const record = createRecord('fetch', 'GET', url);
  keepResponseText(record, text, { compare: true });
  return record;
};

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

  it('큰 응답의 해시는 여러 조각에 나눠 계산하고, 그동안 뒤의 판정은 기다린다', () => {
    const hasher = createResponseHasher(big('0'));
    let steps = 1;
    while (!hasher.step()) steps++;
    expect(steps).toBeGreaterThan(1);
    expect(sameDigest(hasher.digest(), digestOf(big('0')))).toBe(true);

    const a = respond('/api/order', big('0'));
    const b = respond('/api/order', 'small');
    const c = respond('/api/order', 'small');
    flushQueue(0); // 한 조각만: a 의 해시가 아직 끝나지 않았다
    expect(c.sameResponseAs).toBeUndefined();
    flushQueue();
    expect(a.sameResponseAs).toBeUndefined();
    expect(b.sameResponseAs).toBeUndefined();
    expect(c.sameResponseAs).toBe(b.id);
  });

  it('키마다 남는 값은 원문이 아니라 길이와 해시다', () => {
    for (let page = 1; page <= 20; page++) respond(`/api/list?page=${page}`, big(String(page)));
    flushQueue();
    const kept = [...responseMemoryForTest().values()];
    expect(kept).toHaveLength(20);
    for (const value of kept) {
      expect(Object.keys(value.digest).sort()).toEqual(['hi', 'length', 'lo']);
      expect(Object.values(value.digest).every((v) => typeof v === 'number')).toBe(true);
      expect(Object.values(value).some((v) => typeof v === 'string')).toBe(false);
    }
  });

  it('길이가 같고 내용이 다른 응답은 지문이 다르다', () => {
    expect(sameDigest(digestOf('ab'), digestOf('ba'))).toBe(false);
    expect(sameDigest(digestOf(''), digestOf(''))).toBe(true);
    expect(sameDigest(digestOf('a'), digestOf('a\u0000'))).toBe(false);
  });
});
