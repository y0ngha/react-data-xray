import { analyzeBursts, BURST_WINDOW_MS } from '../../../core/requests/bursts.js';
import type { RequestClass } from '../../../core/requests/classify.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import type { LayoutShift } from '../../../core/render/layoutShifts.js';
import type { Commit } from '../../../core/render/types.js';

const TIMELINE_MS = 20_000;
const LANE_H = 6;
const LANE_GAP = 2;
const MAX_LANES = 14;
const COMMIT_H = 40;
const AXIS_H = 20;
const MIN_BAR_W = 3;
const TICK_SECONDS = [0, 5, 10, 15, 20];
// 이 점수면 이동 표시가 렌더 영역 높이를 다 채운다(web-vitals 가 CLS 를 "나쁨"으로 보는 값).
const FULL_SHIFT = 0.25;
const MIN_SHIFT_H = 4;

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

interface ShiftLayout {
  key: number;
  x: number;
  height: number;
  shift: LayoutShift;
}

export interface TimelineLayout {
  width: number;
  height: number;
  laneH: number;
  /** 요청 영역과 렌더 영역의 경계선 위치 */
  dividerY: number;
  commitBaseY: number;
  bars: BarLayout[];
  bursts: BurstLayout[];
  commits: CommitLayout[];
  /** 레이아웃 이동. 렌더 영역 위에서 아래로 점수만큼 내려 그린다 */
  shifts: ShiftLayout[];
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
    all.filter((r) => r.startedAt >= from - BURST_WINDOW_MS),
    classOf,
  ).flatMap((seg) => {
    const inView = seg.records.filter((r) => r.startedAt >= from);
    if (inView.length === 0 || !seg.records.some((r) => shownIds.has(r.id))) return [];
    return [{ from: Math.max(seg.from, from), to: seg.to, count: inView.length, entry: seg.entry }];
  });
};

/**
 * 최근 20초의 요청 막대, 요청 몰림 구간, 렌더 commit 눈금, 레이아웃 이동을 화면 좌표로 계산한다.
 * records 는 그릴 요청(대상으로 좁혔으면 그 안), all 은 몰림 판정에 쓸 전체 기록이다.
 */
export const layoutTimeline = (
  records: readonly RequestRecord[],
  commits: readonly Commit[],
  now: number,
  width: number,
  classOf: (r: RequestRecord) => RequestClass,
  all: readonly RequestRecord[] = records,
  shifts: readonly LayoutShift[] = [],
): TimelineLayout => {
  const from = now - TIMELINE_MS;
  const x = (t: number) => ((t - from) / TIMELINE_MS) * width;
  const visible = records.filter((r) => r.startedAt + r.durationMs >= from);
  const lanes = assignLanes(visible);
  const reqH = Math.max(1, ...lanes.map((l) => l + 1)) * (LANE_H + LANE_GAP);
  const recentCommits = commits.filter((c) => c.time >= from);
  const maxCount = Math.max(1, ...recentCommits.map((c) => c.count));
  return {
    width,
    height: reqH + COMMIT_H + AXIS_H,
    laneH: LANE_H,
    dividerY: reqH + 4,
    commitBaseY: reqH + 6 + COMMIT_H,
    bars: visible.map((record, i) => ({
      record,
      x: x(record.startedAt),
      y: lanes[i] * (LANE_H + LANE_GAP) + LANE_GAP,
      width: Math.max(MIN_BAR_W, x(record.startedAt + record.durationMs) - x(record.startedAt)),
    })),
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
    shifts: shifts
      .filter((s) => s.time >= from)
      .map((shift) => ({
        key: shift.id,
        x: x(shift.time),
        height: Math.max(MIN_SHIFT_H, Math.min(1, shift.value / FULL_SHIFT) * COMMIT_H),
        shift,
      })),
    ticks: TICK_SECONDS.map((seconds) => ({ seconds, x: Math.min(width - 24, x(now - seconds * 1000)) })),
  };
};
