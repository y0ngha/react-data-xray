import { afterEach, describe, expect, it, vi } from 'vitest';

import { readStored, writeStored } from '../storage.js';

const asNumber = (raw: unknown) => (typeof raw === 'number' ? raw : undefined);

describe('storage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('저장한 값을 다시 읽고, 없거나 형식이 틀리면 기본값을 쓴다', () => {
    expect(readStored('k', asNumber, 1)).toBe(1);
    writeStored('k', 5);
    expect(readStored('k', asNumber, 1)).toBe(5);
    writeStored('k', 'not a number');
    expect(readStored('k', asNumber, 1)).toBe(1);
    localStorage.setItem('k', '{broken');
    expect(readStored('k', asNumber, 1)).toBe(1);
  });

  it('저장소를 못 쓰는 환경(시크릿 모드 등)에서도 앱을 깨지 않는다', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeStored('k', 1)).not.toThrow();
    expect(readStored('k', asNumber, 7)).toBe(7);
  });
});
