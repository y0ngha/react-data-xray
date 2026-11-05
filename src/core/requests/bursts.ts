import { hasNavigationIn } from '../capture/navigation.js';
import type { RequestClass } from './classify.js';
import { config } from '../config.js';
import type { RequestRecord } from './types.js';

/** 몰림을 재는 창 길이(기본 500ms, configure 의 burst.windowMs) */
export const burstWindowMs = (): number => config().burstWindowMs;
// 페이지에 들어온 직후와 화면을 옮긴 직후에는 화면 전체가 동시에 데이터를 불러오는 것이 흔하다.
const INITIAL_LOAD_MS = 3000;
// 응답이 끝나고 이만큼 안에 화면을 옮겨도 화면 진입이다(응답을 받은 뒤 주소를 바꾸는 데이터 라우터).
const ENTRY_LOOKAHEAD_MS = 1000;

interface Burst {
  from: number;
  to: number;
  count: number;
}

/** 500ms 창 하나. 창 끝 요청과 그 앞 500ms 안에 시작한 요청들(5건 이상)이다. */
export interface BurstWindow {
  /** 첫 요청의 시작 시각 */
  from: number;
  /** 마지막(창 끝) 요청의 시작 시각 */
  to: number;
  /** 창 안 요청 가운데 가장 늦게 끝난 응답의 시각 */
  end: number;
  /** 화면 진입(페이지 첫 로딩·화면 이동) 직후의 창인지 */
  entry: boolean;
  /** 진입으로 본 근거. 페이지에 들어온 뒤 3초 안이면 initial-load, 아니면 화면 이동(navigation). 낭비 창에는 없다 */
  entryReason?: EntryReason;
}

/** 진입 몰림의 근거: 페이지 첫 로딩, 또는 그 근처의 화면 이동 */
export type EntryReason = 'initial-load' | 'navigation';

/** 이어진 창들을 진입·낭비가 바뀌는 곳에서 자른 구간. 화면에 몰림으로 그린다. */
export interface BurstSegment {
  from: number;
  to: number;
  entry: boolean;
  /** 진입 구간이면 첫 창의 근거 */
  entryReason?: EntryReason;
  /** 이 구간에 든 요청. 한 요청은 한 구간에만 든다. */
  records: RequestRecord[];
  windows: BurstWindow[];
  /** 이 구간이 속한, 겹쳐 이어진 몰림 전체의 마지막 요청 시작 시각 */
  runTo: number;
}

/**
 * 정렬된 시작 시각에서 5건 이상인 500ms 창(기본값. configure 의 burst 로 바꾼다)을 찾는다(두 포인터, O(n)).
 * first·last 는 창의 첫·끝 요청 위치다.
 */
const windowsOf = (sorted: readonly number[]): Array<{ first: number; last: number }> => {
  const out: Array<{ first: number; last: number }> = [];
  const { burstWindowMs: windowMs, burstCount: min } = config();
  let first = 0;
  for (let last = 0; last < sorted.length; last++) {
    while (sorted[last] - sorted[first] > windowMs) first++;
    if (last - first + 1 >= min) out.push({ first, last });
  }
  return out;
};

/** 500ms 안에 요청이 5건 이상 몰린 구간. 겹치는 구간은 합친다. */
export const findBursts = (starts: readonly number[]): Burst[] => {
  const sorted = [...starts].sort((a, b) => a - b);
  const merged: Array<{ first: number; last: number }> = [];
  for (const w of windowsOf(sorted)) {
    const prev = merged.at(-1);
    if (prev && sorted[w.first] <= sorted[prev.last]) prev.last = w.last;
    else merged.push({ ...w });
  }
  return merged.map(({ first, last }) => ({ from: sorted[first], to: sorted[last], count: last - first + 1 }));
};

/** 지금 페이지에 들어온(navigation 시작) 뒤 3초 안인지. 새로고침 전 페이지의 시각(음수)은 아니다. */
export const isInitialLoad = (time: number): boolean => {
  if (typeof performance === 'undefined') return false;
  const sinceLoad = time - performance.timeOrigin;
  return sinceLoad >= 0 && sinceLoad < INITIAL_LOAD_MS;
};

/**
 * 창이 화면 진입인지. 창이 페이지에 들어온 뒤 3초 안에 시작했거나, 화면 이동이
 * [창 시작 − 3초, 창의 마지막 응답 + 1초] 안에 있다. 뒤쪽을 응답 끝에서 재는 것은 데이터 라우터
 * (React Router loader, Next.js App Router 의 RSC 요청)가 새 화면의 응답을 받은 뒤에 주소를 바꾸기 때문이다.
 */
const entryReasonOf = (from: number, end: number): EntryReason | undefined => {
  if (isInitialLoad(from)) return 'initial-load';
  return hasNavigationIn(from - INITIAL_LOAD_MS, end + ENTRY_LOOKAHEAD_MS) ? 'navigation' : undefined;
};

const counted = (classOf: (r: RequestRecord) => RequestClass) => (r: RequestRecord) => {
  // 새로고침 전 페이지의 기록은 이 페이지의 이동 기록과 맞춰 볼 수 없다.
  if (r.restored) return false;
  const c = classOf(r);
  return c !== 'ignored' && c !== 'strict-mode';
};

/** 한 페이지(load) 안의 기록에서 몰림 구간을 찾는다. */
const segmentsOfLoad = (records: RequestRecord[]): BurstSegment[] => {
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  const starts = sorted.map((r) => r.startedAt);
  const ends = sorted.map((r) => r.startedAt + r.durationMs);
  const segments: BurstSegment[] = [];
  let runStart = 0;
  let lastIdx = -1; // 앞 구간이 가져간 마지막 요청 위치
  // 창의 응답 끝 최댓값을 단조 덱으로 구한다.
  const deque: number[] = [];
  let pushed = -1;
  for (const { first, last } of windowsOf(starts)) {
    while (pushed < last) {
      pushed++;
      while (deque.length > 0 && ends[deque.at(-1) ?? 0] <= ends[pushed]) deque.pop();
      deque.push(pushed);
    }
    while (deque[0] < first) deque.shift();
    const entryReason = entryReasonOf(starts[first], ends[deque[0]]);
    const window: BurstWindow = {
      from: starts[first],
      to: starts[last],
      end: ends[deque[0]],
      entry: entryReason !== undefined,
      ...(entryReason && { entryReason }),
    };
    const prev = segments.at(-1);
    const sameRun = prev !== undefined && lastIdx >= 0 && window.from <= starts[lastIdx];
    if (!sameRun) runStart = segments.length;
    if (sameRun && prev.entry === window.entry) {
      prev.windows.push(window);
      prev.records.push(...sorted.slice(lastIdx + 1, last + 1));
      prev.to = window.to;
    } else {
      const startIdx = sameRun ? lastIdx + 1 : first;
      segments.push({
        from: starts[startIdx],
        to: window.to,
        entry: window.entry,
        ...(window.entryReason && { entryReason: window.entryReason }),
        records: sorted.slice(startIdx, last + 1),
        windows: [window],
        runTo: window.to,
      });
    }
    lastIdx = last;
    for (let i = runStart; i < segments.length; i++) segments[i].runTo = window.to;
  }
  return segments;
};

/**
 * 요청 몰림을 500ms 창 단위로 화면 진입·낭비로 가르고, 이어진 창을 판정이 바뀌는 곳에서 잘라 구간으로 돌려준다.
 * 버튼과 타임라인이 같이 써 같은 몰림을 같게 판정한다. 이유가 확실한 반복(무시·StrictMode)과 새로고침 전 기록은
 * 세지 않고, 페이지(load)마다 따로 찾는다. 끝나지 않는 반복은 진입 창을 지나면 낭비 구간이 된다.
 */
export const analyzeBursts = (records: readonly RequestRecord[], classOf: (r: RequestRecord) => RequestClass): BurstSegment[] => {
  const byLoad = new Map<number, RequestRecord[]>();
  for (const r of records.filter(counted(classOf))) {
    const load = r.load ?? 0;
    const group = byLoad.get(load);
    if (group) group.push(r);
    else byLoad.set(load, [r]);
  }
  return [...byLoad.values()].flatMap(segmentsOfLoad).sort((a, b) => a.from - b.from);
};
