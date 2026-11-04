import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 모듈 상태(마지막 경로, 이동 시각)를 테스트마다 새로 시작한다.
const load = async () => {
  vi.resetModules();
  const { trackRouteChanges } = await import('../routeChanges.js');
  const { isInitialLoad } = await import('../../requests/bursts.js');
  return { trackRouteChanges, isInitialLoad };
};

const originals = { pushState: history.pushState, replaceState: history.replaceState };
const now = performance.timeOrigin + 600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now });
  History.prototype.replaceState.call(history, null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.pushState = originals.pushState;
  history.replaceState = originals.replaceState;
});

it('Navigation API 의 navigate 로 다른 경로에 가면 진입이고, 같은 경로·주소 없는 이동은 아니다', async () => {
  const navigation = new EventTarget();
  vi.stubGlobal('navigation', navigation);
  const { trackRouteChanges, isInitialLoad } = await load();
  trackRouteChanges();
  const navigate = (url?: string) =>
    navigation.dispatchEvent(Object.assign(new Event('navigate'), { destination: url ? { url } : undefined }));
  navigate(`${location.origin}/?q=1`);
  navigate();
  expect(isInitialLoad(now + 100)).toBe(false);
  navigate('/intercepted');
  expect(isInitialLoad(now + 100)).toBe(true);
});

it('감싼 history 메서드는 원래 메서드의 this·인자를 그대로 넘기고, 원래 메서드의 오류도 그대로 던진다', async () => {
  const pushState = vi.fn<History['pushState']>();
  const replaceState = vi.fn<History['replaceState']>(() => {
    throw new DOMException('denied', 'SecurityError');
  });
  history.pushState = pushState;
  history.replaceState = replaceState;
  const { trackRouteChanges } = await load();
  trackRouteChanges();
  history.pushState({ a: 1 }, '', '/x');
  expect(pushState).toHaveBeenCalledWith({ a: 1 }, '', '/x');
  expect(pushState.mock.contexts[0]).toBe(history);
  expect(() => history.replaceState(null, '', '/y')).toThrow('denied');
});

it('history 를 바꿀 수 없거나 location 을 읽을 수 없어도 앱을 깨뜨리지 않는다', async () => {
  const { trackRouteChanges, isInitialLoad } = await load();
  const frozen = Object.freeze({ pushState: originals.pushState, replaceState: originals.replaceState });
  vi.stubGlobal('history', frozen);
  expect(() => trackRouteChanges()).not.toThrow();
  vi.unstubAllGlobals();

  trackRouteChanges();
  const spy = vi.spyOn(window, 'location', 'get').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => history.pushState(null, '', '/z')).not.toThrow();
  spy.mockRestore();
  expect(isInitialLoad(now + 100)).toBe(false);
});

it('history 가 없는 환경에서는 아무것도 하지 않는다', async () => {
  const { trackRouteChanges } = await load();
  vi.stubGlobal('history', undefined);
  expect(() => trackRouteChanges()).not.toThrow();
});
