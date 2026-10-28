import { describe, expect, it } from 'vitest';

import type { RequestRecord } from '../../requests/types.js';
import { rememberText, takePendingText } from '../pendingTexts.js';

const rec = (n: number) => ({ id: n }) as unknown as RequestRecord;

describe('pendingTexts', () => {
  it('꺼내면 한 번만 돌려준다', () => {
    rememberText('{"a":1}', rec(1));
    expect(takePendingText('{"a":1}')).toEqual(rec(1));
    expect(takePendingText('{"a":1}')).toBeUndefined();
  });

  it('같은 원문이면 가장 최근 요청을 돌려준다', () => {
    rememberText('{"same":1}', rec(1));
    rememberText('{"same":1}', rec(2));
    expect(takePendingText('{"same":1}')).toEqual(rec(2));
    expect(takePendingText('{"same":1}')).toBeUndefined();
  });

  it('JSON 처럼 보이는 원문만 기억한다(HTML·CSV 같은 큰 원문을 붙잡지 않는다)', () => {
    rememberText('<html>big</html>', rec(1));
    expect(takePendingText('<html>big</html>')).toBeUndefined();
    rememberText('  {"a":1}', rec(2));
    expect(takePendingText('  {"a":1}')).toEqual(rec(2));
  });

  it('pending_no_map: 51번째가 들어오면 가장 오래된 것이 밀려난다', () => {
    for (let i = 0; i < 51; i++) rememberText(`{"n":${i}}`, rec(i));
    expect(takePendingText('{"n":0}')).toBeUndefined();
    expect(takePendingText('{"n":1}')).toEqual(rec(1));
    expect(takePendingText('{"n":50}')).toEqual(rec(50));
  });
});
