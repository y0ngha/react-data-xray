import type { RequestRecord } from './types.js';

const BURST_WINDOW_MS = 500;
const BURST_MIN = 5;
// 페이지에 들어온 직후와 라우트를 옮긴 직후에는 화면 전체가 동시에 데이터를 불러오는 것이 흔하다.
const INITIAL_LOAD_MS = 3000;
// 라우트가 바뀐 지점보다 이만큼 앞선 몰림도 화면 진입이다(주소를 바꾸기 전에 데이터를 받는 라우터).
const ENTRY_LOOKBACK_MS = 1000;

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

/**
 * 라우트가 바뀐 지점(오름차순). 같은 페이지(load) 안에서 앞 요청과 route(pathname)가 다른 요청의 시작 시각이다.
 * history 를 감싸지 않고 기록의 route 로만 정한다. 쿼리·해시만 바뀐 이동은 pathname 이 같아 지점이 아니다.
 * 페이지의 첫 요청은 앞 요청이 없으므로 지점이 아니다(페이지 진입은 isInitialLoad 가 본다).
 */
const findRouteChanges = (records: readonly RequestRecord[]): number[] => {
  const lastRoute = new Map<number, string>();
  const marks: number[] = [];
  for (const r of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    if (r.route === undefined) continue;
    const load = r.load ?? 0;
    const prev = lastRoute.get(load);
    if (prev !== undefined && prev !== r.route) marks.push(r.startedAt);
    lastRoute.set(load, r.route);
  }
  return marks;
};

// 주기적으로 도는 화면이 매번 기록 전체를 정렬하지 않게, 기록이 바뀔 때만 다시 계산한다.
// 저장소는 같은 배열에 넣고 앞에서 버리므로 길이와 처음·끝 기록이 같으면 같은 기록이다.
const marksCache = new WeakMap<
  readonly RequestRecord[],
  { length: number; first?: RequestRecord; last?: RequestRecord; marks: number[] }
>();

const routeChangesOf = (records: readonly RequestRecord[]): number[] => {
  const first = records[0];
  const last = records.at(-1);
  const hit = marksCache.get(records);
  if (hit && hit.length === records.length && hit.first === first && hit.last === last) return hit.marks;
  const marks = findRouteChanges(records);
  marksCache.set(records, { length: records.length, first, last, marks });
  return marks;
};

/** 정렬된 marks 에 lo < m <= hi 인 값이 있는지(이분 탐색) */
const hasMarkIn = (marks: readonly number[], lo: number, hi: number): boolean => {
  let left = 0;
  let right = marks.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (marks[mid] <= lo) left = mid + 1;
    else right = mid;
  }
  return left < marks.length && marks[left] <= hi;
};

/**
 * 몰림 시작 시각으로 화면 진입 몰림인지 판정하는 함수. 몰림 단위로 판정해, 지점에 걸친 몰림을 반만 빼지 않는다.
 * 페이지에 들어온 뒤 3초 안이거나, 라우트가 바뀐 지점의 1초 전부터 3초 뒤까지다. 데이터 라우터(React Router loader,
 * Next.js App Router 의 RSC 요청)는 새 화면의 요청을 주소를 바꾸기 전에 보내 앞 화면의 route 를 달고 있기 때문이다.
 */
export const screenEntryTest = (records: readonly RequestRecord[]): ((from: number) => boolean) => {
  const marks = routeChangesOf(records);
  return (from) => isInitialLoad(from) || hasMarkIn(marks, from - INITIAL_LOAD_MS, from + ENTRY_LOOKBACK_MS);
};
