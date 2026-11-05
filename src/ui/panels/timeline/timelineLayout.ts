import { analyzeBursts, burstWindowMs } from '../../../core/requests/bursts.js';
import type { RequestClass } from '../../../core/requests/classify.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import type { Commit } from '../../../core/render/types.js';

const TIMELINE_MS = 20_000;
const LANE_H = 6;
const LANE_GAP = 2;
const MAX_LANES = 14;
const COMMIT_H = 40;
const AXIS_H = 20;
const MIN_BAR_W = 3;
const TICK_SECONDS = [0, 5, 10, 15, 20];

export interface BarLayout {
  record: RequestRecord;
  x: number;
  y: number;
  width: number;
}

interface BurstLayout {
  key: number;
  x: number;
  width: number;
  count: number;
  /** 화면 진입(페이지 첫 로딩·화면 이동) 직후의 몰림(확인 필요)인지 */
  initial: boolean;
}

interface CommitLayout {
  key: number;
  x: number;
  height: number;
  time: number;
  count: number;
}

/** 워터폴 화살표: 앞 요청 막대의 끝(응답)에서, 그 응답이 마운트한 컴포넌트가 보낸 요청 막대의 시작으로 */
export interface LinkLayout {
  key: number;
  from: RequestRecord;
  to: RequestRecord;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TimelineLayout {
  width: number;
  height: number;
  laneH: number;
  /** 요청 영역과 렌더 영역의 경계선 위치 */
  dividerY: number;
  commitBaseY: number;
  bars: BarLayout[];
  /** 둘 다 보이는 워터폴 고리 */
  links: LinkLayout[];
  bursts: BurstLayout[];
  commits: CommitLayout[];
  ticks: Array<{ seconds: number; x: number }>;
}

/** 겹치는 요청은 아래 줄로 쌓는다. 줄이 모자라면 마지막 줄에 겹친다. */
const assignLanes = (records: readonly RequestRecord[]): number[] =>
  records.reduce<{ lanes: number[]; ends: number[] }>(
    ({ lanes, ends }, r) => {
      const free = ends.findIndex((end) => end <= r.startedAt);
      const lane = free !== -1 ? free : Math.min(ends.length, MAX_LANES - 1);
      const nextEnds = [...ends];
      nextEnds[lane] = r.startedAt + Math.max(r.durationMs, 1);
      return { lanes: [...lanes, lane], ends: nextEnds };
    },
    { lanes: [], ends: [] },
  ).lanes;

/** 보이는 막대끼리의 워터폴 고리(record.waterfallFrom). 화살표는 막대 세로 가운데를 잇는다. */
const waterfallLinks = (bars: readonly BarLayout[]): LinkLayout[] => {
  const byId = new Map(bars.map((b) => [b.record.id, b]));
  return bars.flatMap((to) => {
    const from = to.record.waterfallFrom === undefined ? undefined : byId.get(to.record.waterfallFrom);
    if (!from) return [];
    return [
      {
        key: to.record.id,
        from: from.record,
        to: to.record,
        x1: from.x + from.width,
        y1: from.y + LANE_H / 2,
        x2: to.x,
        y2: to.y + LANE_H / 2,
      },
    ];
  });
};

/**
 * 몰림 구간. 버튼과 같게 전체 기록으로 판정하고(대상으로 좁혀도 판정이 버튼과 어긋나지 않는다), 보이는 요청이
 * 든 구간만 남긴다. 20초 창에 창 하나(500ms)만큼 앞을 더 보고, 구간은 창 안으로 잘라 보이는 요청만 센다.
 */
const visibleBursts = (
  shown: readonly RequestRecord[],
  all: readonly RequestRecord[],
  from: number,
  classOf: (r: RequestRecord) => RequestClass,
) => {
  const shownIds = new Set(shown.map((r) => r.id));
  return analyzeBursts(
    all.filter((r) => r.startedAt >= from - burstWindowMs()),
    classOf,
  ).flatMap((seg) => {
    const inView = seg.records.filter((r) => r.startedAt >= from);
    if (inView.length === 0 || !seg.records.some((r) => shownIds.has(r.id))) return [];
    return [{ from: Math.max(seg.from, from), to: seg.to, count: inView.length, entry: seg.entry }];
  });
};

/**
 * 최근 20초의 요청 막대, 워터폴 화살표, 요청 몰림 구간, 렌더 commit 눈금을 화면 좌표로 계산한다.
 * records 는 그릴 요청(대상으로 좁혔으면 그 안), all 은 몰림 판정에 쓸 전체 기록이다.
 */
export const layoutTimeline = (
  records: readonly RequestRecord[],
  commits: readonly Commit[],
  now: number,
  width: number,
  classOf: (r: RequestRecord) => RequestClass,
  all: readonly RequestRecord[] = records,
): TimelineLayout => {
  const from = now - TIMELINE_MS;
  const x = (t: number) => ((t - from) / TIMELINE_MS) * width;
  const visible = records.filter((r) => r.startedAt + r.durationMs >= from);
  const lanes = assignLanes(visible);
  const reqH = Math.max(1, ...lanes.map((l) => l + 1)) * (LANE_H + LANE_GAP);
  const recentCommits = commits.filter((c) => c.time >= from);
  const maxCount = Math.max(1, ...recentCommits.map((c) => c.count));
  const bars = visible.map((record, i) => ({
    record,
    x: x(record.startedAt),
    y: lanes[i] * (LANE_H + LANE_GAP) + LANE_GAP,
    width: Math.max(MIN_BAR_W, x(record.startedAt + record.durationMs) - x(record.startedAt)),
  }));
  return {
    width,
    height: reqH + COMMIT_H + AXIS_H,
    laneH: LANE_H,
    dividerY: reqH + 4,
    commitBaseY: reqH + 6 + COMMIT_H,
    bars,
    links: waterfallLinks(bars),
    bursts: visibleBursts(records, all, from, classOf).map((b) => ({
      key: b.from,
      x: x(b.from) - 2,
      width: Math.max(4, x(b.to) - x(b.from) + 4),
      count: b.count,
      initial: b.entry,
    })),
    commits: recentCommits.map((c) => ({
      key: c.id,
      x: x(c.time),
      height: Math.max(2, (c.count / maxCount) * COMMIT_H),
      time: c.time,
      count: c.count,
    })),
    ticks: TICK_SECONDS.map((seconds) => ({ seconds, x: Math.min(width - 24, x(now - seconds * 1000)) })),
  };
};
