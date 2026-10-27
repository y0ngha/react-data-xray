import { describe, expect, it } from 'vitest';

import { endpointOf, pathOf, requestKeyOf } from '../requestKey.js';

describe('requestKey', () => {
  it('같은 출처는 경로만, 다른 출처는 호스트를 붙인다', () => {
    expect(pathOf('/api/x?a=1')).toBe('/api/x');
    expect(pathOf(`${location.origin}/api/x`)).toBe('/api/x');
    expect(pathOf('https://other.io/api/x')).toBe('other.io/api/x');
    expect(pathOf('http://[bad?x=1')).toBe('http://[bad');
  });

  it('엔드포인트는 쿼리를 빼고 상대·절대 경로를 하나로 모은다', () => {
    expect(endpointOf({ method: 'GET', url: '/api/x?a=1' })).toBe(endpointOf({ method: 'GET', url: `${location.origin}/api/x?b=2` }));
  });

  it('요청 키는 쿼리 순서는 무시하고 쿼리 값·payload 가 다르면 구분한다', () => {
    const key = (url: string, requestBody?: string) => requestKeyOf({ method: 'GET', url, requestBody });
    expect(key('/a?x=1&y=2')).toBe(key('/a?y=2&x=1'));
    expect(key('/a?x=1')).not.toBe(key('/a?x=2'));
    expect(key('/a', '{"q":1}')).not.toBe(key('/a', '{"q":2}'));
    expect(key('http://[bad')).toBe('GET http://[bad ');
  });
});
