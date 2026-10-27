import { describe, expect, it } from 'vitest';

import { findBursts, isInitialLoad } from '../bursts.js';

describe('findBursts', () => {
  it('500ms 안에 5건 이상이면 몰림 구간으로 묶는다', () => {
    expect(findBursts([0, 100, 200, 300, 400, 2000])).toEqual([{ from: 0, to: 400, count: 5 }]);
  });

  it('간격이 벌어진 요청은 몰림이 아니다', () => {
    expect(findBursts([0, 600, 1200, 1800, 2400])).toEqual([]);
    expect(findBursts([])).toEqual([]);
  });

  it('이어지는 몰림은 한 구간으로 합치고, 정렬되지 않은 입력도 처리한다', () => {
    expect(findBursts([700, 0, 100, 600, 200, 300, 400, 500])).toEqual([{ from: 0, to: 700, count: 8 }]);
  });

  it('떨어진 두 몰림은 따로 센다', () => {
    const burst = (start: number) => [0, 50, 100, 150, 200].map((d) => start + d);
    expect(findBursts([...burst(0), ...burst(5000)])).toEqual([
      { from: 0, to: 200, count: 5 },
      { from: 5000, to: 5200, count: 5 },
    ]);
  });
});

describe('isInitialLoad', () => {
  it('페이지 진입 후 3초 안이면 첫 로딩이다', () => {
    expect(isInitialLoad(performance.timeOrigin + 1000)).toBe(true);
    expect(isInitialLoad(performance.timeOrigin + 5000)).toBe(false);
  });
});
