import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isInitialLoad } from '../bursts.js';

// #82: 페이지 로드 3초 뒤 SPA 라우트를 옮기면 새 화면의 진입 몰림이 낭비로 잡혔다.
// setup.ts 가 설치한 가로채기(`installCapture`)로 history 가 이미 감싸져 있다.
describe('라우트 이동 직후 몰림은 화면 진입이다 (#82)', () => {
  // 페이지 로드 첫 3초와 겹치지 않게, 테스트마다 앞 테스트와도 떨어진 시각에서 시작한다.
  let now = performance.timeOrigin + 60_000;

  beforeEach(() => {
    now += 60_000;
    vi.useFakeTimers({ toFake: ['Date'], now });
    history.replaceState(null, '', `/start-${now}`);
    now += 10_000;
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    history.replaceState(null, '', '/');
  });

  it('pushState 로 경로를 옮긴 뒤 3초 안의 시각은 화면 진입이다', () => {
    expect(isInitialLoad(now + 500)).toBe(false);
    history.pushState(null, '', '/orders');
    expect(isInitialLoad(now + 500)).toBe(true);
    expect(isInitialLoad(now + 2999)).toBe(true);
    // 이동 전 시각, 3초 뒤는 아니다.
    expect(isInitialLoad(now - 1)).toBe(false);
    expect(isInitialLoad(now + 3000)).toBe(false);
  });

  it('replaceState 로 경로를 바꾸면 진입이고, 쿼리·해시만 바꾸면 진입이 아니다', () => {
    const path = location.pathname;
    history.replaceState(null, '', `${path}?filter=open`);
    history.replaceState(null, '', `${path}?filter=done#top`);
    history.pushState(null, '', `${path}?page=2`);
    expect(isInitialLoad(now + 500)).toBe(false);
    history.replaceState(null, '', '/users');
    expect(isInitialLoad(now + 500)).toBe(true);
  });

  it('뒤로 가기(popstate)로 경로가 바뀌면 진입이다', () => {
    // 경로가 그대로인 popstate(해시 이동 등)는 진입이 아니다.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(isInitialLoad(now + 500)).toBe(false);
    // 뒤로 가기는 감싼 pushState 를 거치지 않고 주소를 바꾼 뒤 popstate 를 보낸다. 원래 메서드로 흉내 낸다.
    History.prototype.replaceState.call(history, null, '', '/back');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(isInitialLoad(now + 500)).toBe(true);
  });

  it('이동 없이 생긴 몰림은 지금처럼 진입이 아니다', () => {
    expect(isInitialLoad(now + 100)).toBe(false);
  });
});
