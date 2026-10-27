import { describe, expect, it } from 'vitest';

import { getRecords } from '../../requests/store.js';

describe('요청 문맥', () => {
  it('요청을 보낸 코드 위치를 남기되 rdx 가로채기 프레임은 뺀다', async () => {
    await fetch('/api/where');
    const { stack } = getRecords()[0];
    expect(stack).toContain('requestContext.test');
    expect(stack).not.toContain('fetchInterceptor');
  });

  it('창 포커스·탭 표시·재연결 직후의 요청에 자동 재요청 표시를 붙인다', async () => {
    window.dispatchEvent(new Event('focus'));
    await fetch('/api/after-focus');
    document.dispatchEvent(new Event('visibilitychange'));
    await fetch('/api/after-visible');
    window.dispatchEvent(new Event('online'));
    await fetch('/api/after-online');
    expect(getRecords().map((r) => r.trigger)).toEqual(['focus', 'focus', 'reconnect']);
  });
});
