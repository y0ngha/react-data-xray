import { describe, expect, it } from 'vitest';

import { getEndpointStats } from '../endpointStats.js';
import { endpointOf, requestKeyOf } from '../requestKey.js';
import type { RequestRecord } from '../types.js';

const ep = (url: string, method = 'GET') => endpointOf({ method, url });

describe('이슈 14: 경로 안의 ID 묶기', () => {
  it('숫자·UUID·긴 16진수·접두사형 조각을 :id 로 묶는다', () => {
    expect(ep('/api/users/42')).toBe('GET /api/users/:id');
    expect(ep('/api/v2/orders/3f2a9c1e-1b2d-4c3e-8f90-0a1b2c3d4e5f')).toBe('GET /api/v2/orders/:id');
    expect(ep('/files/0123456789abcdef0123')).toBe('GET /files/:id');
    expect(ep('/g/usr_8f3a9c2d/x')).toBe('GET /g/:id/x'); // prefixed_id
    expect(ep('/g/grp0a1b2c3d4e5f60718293a4b5c')).toBe('GET /g/:id');
  });

  it('버전·영단어·짧은 조각은 그대로다', () => {
    expect(ep('/api/v2/users/me')).toBe('GET /api/v2/users/me');
    expect(ep('/api/members/deadbeef')).toBe('GET /api/members/deadbeef');
    expect(ep('/api/user_profile')).toBe('GET /api/user_profile');
  });

  it('다른 출처는 호스트를 건드리지 않는다', () => {
    expect(ep('https://other.io/a/7')).toBe('GET other.io/a/:id');
  });

  it('classify_unchanged: 같은 요청 키는 원래 URL 기준이다', () => {
    const key = (url: string) => requestKeyOf({ method: 'GET', url });
    expect(key('/api/users/1')).not.toBe(key('/api/users/2'));
    expect(key('/api/users/1')).toContain('/api/users/1');
  });

  it('엔드포인트 줄에 묶인 경로 수를 단다', () => {
    const rec = (id: number, url: string) => ({ id, method: 'GET', url, durationMs: 10 }) as RequestRecord;
    const stats = getEndpointStats([rec(1, '/u/1'), rec(2, '/u/2'), rec(3, '/u/2'), rec(4, '/me')], new Map());
    expect(stats.find((s) => s.endpoint === 'GET /u/:id')).toMatchObject({ count: 3, idVariants: 2 });
    expect(stats.find((s) => s.endpoint === 'GET /me')?.idVariants).toBeUndefined();
  });
});
