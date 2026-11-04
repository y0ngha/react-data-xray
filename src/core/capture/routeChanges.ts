import { attempt } from './attempt.js';
import { markRouteChange } from '../requests/bursts.js';

interface NavigateEventLike extends Event {
  destination?: { url?: string };
}

let lastPath = '';

// 경로가 바뀌었을 때만 화면 진입으로 본다. 쿼리·해시만 바꾸는 필터 화면은 같은 화면이다.
const notePath = (path: string | undefined): void => {
  if (path === undefined || path === lastPath) return;
  lastPath = path;
  markRouteChange(Date.now());
};

const pathOf = (url?: string): string | undefined =>
  attempt(() => (url === undefined ? window.location.pathname : new URL(url, window.location.href).pathname));

const wrapHistory = (name: 'pushState' | 'replaceState'): void => {
  const original = history[name];
  if (typeof original !== 'function') return;
  function wrapped(this: History, ...args: Parameters<History['pushState']>): void {
    original.apply(this, args);
    // 앱의 이동은 이미 끝났다. 기록은 실패해도 앱에 알리지 않는다.
    attempt(() => notePath(pathOf()));
  }
  // 바꿀 수 없는 환경이면 감싸지 않는다.
  attempt(() => {
    history[name] = wrapped;
  });
};

/**
 * SPA 라우트 이동 시각을 기억한다. 이동 직후의 요청 몰림은 낭비가 아니라 화면 진입이다(`isInitialLoad`).
 * `pushState`·`replaceState` 를 감싸고 `popstate`, Navigation API 가 있으면 `navigate` 를 듣는다.
 */
export const trackRouteChanges = (): void => {
  if (typeof history === 'undefined') return;
  lastPath = pathOf() ?? '';
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => notePath(pathOf()));
  const navigation = (window as { navigation?: EventTarget }).navigation;
  if (typeof navigation?.addEventListener !== 'function') return;
  // intercept() 로 history 를 거치지 않고 옮기는 라우터도 있으므로 도착 경로로 기록한다.
  navigation.addEventListener('navigate', (event) => {
    const url = (event as NavigateEventLike).destination?.url;
    if (url !== undefined) notePath(pathOf(url));
  });
};
