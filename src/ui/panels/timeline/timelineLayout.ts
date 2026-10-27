import { findBursts, isInitialLoad } from '../../../core/requests/bursts.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import type { Commit } from '../../../core/render/types.js';

export const TIMELINE_MS = 20_000;
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

export interface BurstLayout {
  key: number;
  x: number;
  width: number;
  count: number;
  /** 페이지 진입 직후의 몰림(확인 필요)인지 */
  initial: boolean;
}

export interface CommitLayout {
  key: number;
  x: number;
  height: number;
  time: number;
  count: number;
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

/** 최근 20초의 요청 막대, 요청 몰림 구간, 렌더 commit 눈금을 화면 좌표로 계산한다. */
export const layoutTimeline = (
  records: readonly RequestRecord[],
  commits: readonly Commit[],
  now: number,
  width: number,
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
    bursts: findBursts(visible.map((r) => r.startedAt)).map((b) => ({
      key: b.from,
      x: x(b.from) - 2,
      width: Math.max(4, x(b.to) - x(b.from) + 4),
      count: b.count,
      initial: isInitialLoad(b.from),
    })),
    commits: recentCommits.map((c) => ({
      key: c.time,
      x: x(c.time),
      height: Math.max(2, (c.count / maxCount) * COMMIT_H),
      time: c.time,
      count: c.count,
    })),
    ticks: TICK_SECONDS.map((seconds) => ({ seconds, x: Math.min(width - 24, x(now - seconds * 1000)) })),
  };
};
