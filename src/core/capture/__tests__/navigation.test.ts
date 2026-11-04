import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 모듈 상태(마지막 화면, 이동 시각)를 테스트마다 새로 시작한다.
const load = async () => {
  vi.resetModules();
  return import('../navigation.js');
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
  vi.restoreAllMocks();
  history.pushState = originals.pushState;
  history.replaceState = originals.replaceState;
});

it('감싼 메서드는 원래 메서드를 같은 this·인자로 먼저 부르고 반환값을 돌려준 뒤 이동을 기록한다', async () => {
  const seen: string[] = [];
  const pushState = vi.fn<History['pushState']>(function (this: History, _data, _unused, url) {
    seen.push(location.pathname);
    History.prototype.pushState.call(this, null, '', url);
    return 'native-result' as unknown as void;
  });
  history.pushState = pushState;
  const { trackNavigation, hasNavigationIn } = await load();
  trackNavigation();
  const result: unknown = history.pushState({ a: 1 }, '', '/x');
  expect(result).toBe('native-result');
  expect(pushState).toHaveBeenCalledWith({ a: 1 }, '', '/x');
  expect(pushState.mock.contexts[0]).toBe(history);
  // 원래 메서드가 불릴 때는 아직 기록 전이고, 기록은 바뀐 location 으로 한다.
  expect(seen).toEqual(['/']);
  expect(hasNavigationIn(now - 1, now)).toBe(true);
  expect(hasNavigationIn(now, now + 1)).toBe(false);
});

it('원래 메서드의 오류는 앱에 그대로 가고, 그때는 기록하지 않는다', async () => {
  history.replaceState = vi.fn<History['replaceState']>(() => {
    throw new DOMException('denied', 'SecurityError');
  });
  const { trackNavigation, hasNavigationIn } = await load();
  trackNavigation();
  expect(() => history.replaceState(null, '', '/y')).toThrow('denied');
  expect(hasNavigationIn(now - 1, now)).toBe(false);
});

it('history 를 바꿀 수 없거나 location 을 읽을 수 없어도 앱을 깨뜨리지 않는다', async () => {
  const { trackNavigation, hasNavigationIn } = await load();
  vi.stubGlobal('history', Object.freeze({ pushState: originals.pushState, replaceState: originals.replaceState }));
  expect(() => trackNavigation()).not.toThrow();
  vi.unstubAllGlobals();

  trackNavigation();
  vi.spyOn(window, 'location', 'get').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => history.pushState(null, '', '/z')).not.toThrow();
  expect(() => window.dispatchEvent(new PopStateEvent('popstate'))).not.toThrow();
  vi.restoreAllMocks();
  expect(hasNavigationIn(now - 1, now)).toBe(false);
});

it('시계가 뒤로 가도 이동 시각을 오름차순으로 두고, 최근 200건만 둔다', async () => {
  const { trackNavigation, hasNavigationIn } = await load();
  trackNavigation();
  history.pushState(null, '', '/a');
  vi.setSystemTime(now - 5000);
  history.pushState(null, '', '/b');
  expect(hasNavigationIn(now - 5001, now - 5000)).toBe(true);
  expect(hasNavigationIn(now - 1, now)).toBe(true);
  for (let i = 1; i <= 200; i++) {
    vi.setSystemTime(now + i * 10);
    history.pushState(null, '', `/p${i}`);
  }
  // 가장 오래된 두 건(now - 5000, now)은 밀려났다.
  expect(hasNavigationIn(now - 6000, now)).toBe(false);
  expect(hasNavigationIn(now, now + 10)).toBe(true);
});

it('history 가 없는 환경에서는 아무것도 하지 않는다', async () => {
  const { trackNavigation } = await load();
  vi.stubGlobal('history', undefined);
  expect(() => trackNavigation()).not.toThrow();
});
