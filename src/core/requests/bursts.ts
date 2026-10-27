const BURST_WINDOW_MS = 500;
const BURST_MIN = 5;
// 페이지에 들어온 직후에는 화면 전체가 동시에 데이터를 불러오는 것이 흔하다.
const INITIAL_LOAD_MS = 3000;

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

/** 지금 페이지에 들어온(navigation 시작) 뒤 3초 안인지. 새로고침 전 페이지의 시각(음수)은 아니다. */
export const isInitialLoad = (time: number): boolean => {
  if (typeof performance === 'undefined') return false;
  const sinceLoad = time - performance.timeOrigin;
  return sinceLoad >= 0 && sinceLoad < INITIAL_LOAD_MS;
};
