import { describe, expect, it } from 'vitest';

import { classifyRecords, isPeriodic, periodicStarts } from '../classify.js';
import type { RequestRecord } from '../types.js';

let id = 0;
const rec = (startedAt: number, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  id: ++id,
  kind: 'fetch',
  method: 'GET',
  url: '/api/poll',
  status: 200,
  startedAt,
  durationMs: 10,
  body: undefined,
  ...extra,
});
// 같은 응답을 계속 받는 polling 기록(첫 요청 뒤로는 모두 같은 응답 재요청)
const polls = (starts: number[]): RequestRecord[] => {
  const list: RequestRecord[] = [];
  starts.forEach((t) => list.push(rec(t, list.length ? { sameResponseAs: list[list.length - 1].id } : {})));
  return list;
};
const classesOf = (list: RequestRecord[]) => {
  const classes = classifyRecords(list, new Set());
  return list.slice(1).map((r) => classes.get(r.id));
};

describe('이슈 62: 한 번 어긋난 간격이 polling 기록 전체를 빨강으로 만들지 않는다', () => {
  it('탭을 숨겨 한 번 끊긴 10초 polling 은 끊긴 앞뒤 모두 주기 요청이다', () => {
    const starts = [0, 10_000, 20_000, 30_000, 70_000, 80_000, 90_000];
    expect(isPeriodic(starts)).toBe(true);
    expect(classesOf(polls(starts))).toEqual(Array(6).fill('periodic'));
  });

  it('끊긴 뒤 두 번만 받았어도 같은 주기로 이어지면 주기 요청이다', () => {
    expect(classesOf(polls([0, 10_000, 20_000, 30_000, 40_000, 75_000, 85_000]))).toEqual(Array(6).fill('periodic'));
  });

  it('사이에 한 번 끼어든 재조회만 빼고 나머지는 주기 요청으로 남는다', () => {
    const list = polls([0, 10_000, 20_000, 24_000, 30_000, 40_000, 50_000]);
    expect(classesOf(list)).toEqual(['periodic', 'periodic', 'same-response', 'periodic', 'periodic', 'periodic']);
    expect(periodicStarts(list.map((r) => r.startedAt))).toEqual([true, true, true, false, true, true, true]);
  });

  it('입력 순서가 섞여 있어도 시작 시각 순으로 본다', () => {
    expect(periodicStarts([20_000, 0, 24_000, 10_000, 30_000])).toEqual([true, true, false, true, true]);
  });

  describe('불규칙한 반복은 지금처럼 주기 요청이 아니다', () => {
    it.each([
      ['들쭉날쭉한 간격', [0, 1_200, 4_000, 4_900]],
      ['두 건씩만 맞는 간격', [0, 2_000, 9_000, 10_000]],
      ['1초보다 짧은 간격', [0, 300, 600, 900]],
      ['두 번뿐', [0, 10_000]],
      // 우연히 다섯 건이 한 주기로 이어져도, 구간 밖 요청이 많으면 주기가 아니다
      ['구간 밖이 많은 반복', [0, 3_000, 6_000, 7_100, 8_300, 11_900, 13_000, 17_500, 18_100, 21_700]],
    ])('%s', (_, starts) => {
      expect(isPeriodic(starts)).toBe(false);
      expect(classesOf(polls(starts)).includes('periodic')).toBe(false);
    });
  });
});
