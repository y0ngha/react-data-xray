import { describe, expect, it } from 'vitest';

import { visibleBurstLabels } from '../timeline/TimelineChart.js';

describe('타임라인 몰림 라벨', () => {
  it('겹치는 라벨은 앞의 것만 남긴다', () => {
    // 오른쪽 절반의 두 구간: 라벨이 구간 오른쪽 끝에 붙어 서로 겹친다
    const bursts = [
      { x: 140, width: 6, count: 12, initial: false },
      { x: 200, width: 6, count: 6, initial: true },
    ];
    expect(visibleBurstLabels(bursts, 230)).toEqual([true, false]);
  });

  it('떨어진 라벨은 모두 그린다', () => {
    const bursts = [
      { x: 0, width: 6, count: 3, initial: true },
      { x: 400, width: 6, count: 5, initial: false },
    ];
    expect(visibleBurstLabels(bursts, 456)).toEqual([true, true]);
  });
});
