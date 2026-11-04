import { attempt } from './attempt.js';

// 오래 켜 둔 탭에서도 끝없이 늘지 않게 최근 이동만 둔다.
const MAX_MARKS = 200;
// 해시 라우터(`#/users`, `#!/users`)의 경로. 페이지 안 앵커(`#section`)는 화면 이동이 아니다.
const HASH_ROUTE = /^#!?(\/[^?]*)/;

/** 화면(라우트)이 바뀐 시각. 오름차순이다. */
const marks: number[] = [];
let lastRoute: string | undefined;

/** 지금 화면의 이름. pathname 에 해시 라우터 경로를 붙인다. 쿼리만 바뀐 것은 같은 화면이다. */
const routeKey = (): string => {
  const { pathname, hash } = window.location;
  const hashRoute = HASH_ROUTE.exec(hash)?.[1];
  return hashRoute === undefined ? pathname : `${pathname}#${hashRoute}`;
};

const addMark = (time: number): void => {
  // 시계가 뒤로 가도(시스템 시간 조정) 오름차순을 지킨다.
  marks.push(time);
  if (marks.length > 1 && marks[marks.length - 2] > time) marks.sort((a, b) => a - b);
  if (marks.length > MAX_MARKS) marks.shift();
};

/** 이동이 끝난 뒤 location 을 읽어, 화면이 바뀌었으면 시각을 남긴다. */
const noteRoute = (): void => {
  const route = routeKey();
  if (route === lastRoute) return;
  lastRoute = route;
  addMark(Date.now());
};

const wrapHistory = (name: 'pushState' | 'replaceState'): void => {
  const original = history[name];
  if (typeof original !== 'function') return;
  // 원래 메서드를 같은 this·인자로 먼저 부르고 그 반환값을 돌려준다. 원래 메서드의 오류는 앱에 그대로 간다.
  // 기록은 그 뒤에 attempt 안에서 한다(rdx 실패가 앱으로 새지 않는다).
  const wrapped = function (this: History, ...args: Parameters<History['pushState']>) {
    const result: unknown = original.apply(this, args);
    attempt(noteRoute);
    return result;
  } as History['pushState'];
  // 바꿀 수 없는 환경(고정된 history 등)이면 감싸지 않는다.
  attempt(() => {
    history[name] = wrapped;
  });
};

/**
 * SPA 화면 이동 시각을 기록한다. 이동 직후의 요청 몰림은 낭비가 아니라 화면 진입이다(`classifyBursts`).
 * pushState·replaceState 를 감싸고 popstate·hashchange 를 듣는다. Navigation API 의 navigate 는 이동이 확정되기
 * 전에 오므로(취소·다운로드도 온다) 쓰지 않는다.
 */
export const trackNavigation = (): void => {
  if (typeof history === 'undefined') return;
  lastRoute = attempt(routeKey);
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => attempt(noteRoute));
  window.addEventListener('hashchange', () => attempt(noteRoute));
};

/** lo < m <= hi 인 이동 시각이 있는지(이분 탐색) */
export const hasNavigationIn = (lo: number, hi: number): boolean => {
  let left = 0;
  let right = marks.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (marks[mid] <= lo) left = mid + 1;
    else right = mid;
  }
  return left < marks.length && marks[left] <= hi;
};
