const BURST_WINDOW_MS = 500;
const BURST_MIN = 5;
// 페이지에 들어온 직후와 SPA 라우트를 옮긴 직후에는 화면 전체가 동시에 데이터를 불러오는 것이 흔하다.
const INITIAL_LOAD_MS = 3000;
// 오래 켜 둔 탭에서도 끝없이 늘지 않게, 라우트 이동 시각은 최근 것만 둔다.
const ROUTE_CHANGES_KEPT = 200;

const routeChangedAt: number[] = [];

/** 라우트를 옮긴 시각을 기억한다. 가로채기(`capture/routeChanges.ts`)가 부른다. */
export const markRouteChange = (time: number): void => {
  routeChangedAt.push(time);
  if (routeChangedAt.length > ROUTE_CHANGES_KEPT) routeChangedAt.shift();
};

const within3s = (time: number, start: number): boolean => time - start >= 0 && time - start < INITIAL_LOAD_MS;

interface Burst {
  from: number;
  to: number;
  count: number;
}

/** 500ms 안에 요청이 5건 이상 몰린 구간. 겹치는 구간은 합친다. */
export const findBursts = (starts: readonly number[]): Burst[] => {
  const sorted = [...starts].sort((a, b) => a - b);
  // 각 요청을 끝으로 하는 500ms 창 가운데 5건 이상인 것
  const windows = sorted
    .map((to, i) => ({ first: sorted.findIndex((s) => to - s <= BURST_WINDOW_MS), to, i }))
    .filter(({ first, i }) => i - first + 1 >= BURST_MIN)
    .map(({ first, to }) => ({ from: sorted[first], to }));
  // 겹치는 창은 하나로 합친다.
  const merged: Array<{ from: number; to: number }> = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && w.from <= last.to) last.to = w.to;
    else merged.push({ ...w });
  }
  return merged.map(({ from, to }) => ({ from, to, count: sorted.filter((t) => t >= from && t <= to).length }));
};

/**
 * 화면에 들어온 뒤 3초 안인지. 지금 페이지에 들어온(navigation 시작) 뒤이거나 라우트를 옮긴 뒤다.
 * 새로고침 전 페이지의 시각(지금 페이지보다 앞선 시각)은 아니다.
 */
export const isInitialLoad = (time: number): boolean => {
  if (typeof performance !== 'undefined' && within3s(time, performance.timeOrigin)) return true;
  return routeChangedAt.some((at) => within3s(time, at));
};
