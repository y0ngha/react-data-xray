import { hasNavigationIn } from '../capture/navigation.js';
import type { RequestClass } from './classify.js';
import type { RequestRecord } from './types.js';

const BURST_WINDOW_MS = 500;
const BURST_MIN = 5;
// 페이지에 들어온 직후와 라우트를 옮긴 직후에는 화면 전체가 동시에 데이터를 불러오는 것이 흔하다.
const INITIAL_LOAD_MS = 3000;
// 화면 이동보다 이만큼 앞선 몰림도 화면 진입이다(주소를 바꾸기 전에 데이터를 받는 라우터).
const ENTRY_LOOKBACK_MS = 1000;

interface Burst {
  from: number;
  to: number;
  count: number;
}

export interface ClassifiedBurst extends Burst {
  /** 화면 진입(페이지 첫 로딩·화면 이동) 직후의 몰림(확인 필요)인지 */
  entry: boolean;
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
 * 몰림 시작 시각이 화면 진입인지. 페이지에 들어온 뒤 3초 안이거나, 화면 이동의 1초 전부터 3초 뒤까지다.
 * 1초 앞까지 보는 것은 데이터 라우터(React Router loader, Next.js App Router 의 RSC 요청)가 새 화면의 요청을
 * 주소를 바꾸기 전에 보내기 때문이다.
 */
const isScreenEntry = (from: number): boolean => isInitialLoad(from) || hasNavigationIn(from - INITIAL_LOAD_MS, from + ENTRY_LOOKBACK_MS);

/**
 * 요청 몰림을 찾아 화면 진입 몰림인지 가른다. 버튼과 타임라인이 같이 써 같은 몰림을 같게 판정한다.
 * 이유가 확실한 반복(무시·StrictMode)은 몰림에 세지 않는다. 진입인지는 요청이 아니라 몰림 단위로 본다.
 */
export const classifyBursts = (records: readonly RequestRecord[], classOf: (r: RequestRecord) => RequestClass): ClassifiedBurst[] => {
  const starts = records
    .filter((r) => {
      const c = classOf(r);
      return c !== 'ignored' && c !== 'strict-mode';
    })
    .map((r) => r.startedAt);
  return findBursts(starts).map(({ from, to, count }) => ({ from, to, count, entry: isScreenEntry(from) }));
};
