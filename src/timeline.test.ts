import { describe, expect, it } from 'vitest';

import { findBursts } from './Devtools.js';

describe('findBursts', () => {
  it('500ms 안에 5건 이상이면 몰림 구간으로 묶는다', () => {
    expect(findBursts([0, 100, 200, 300, 400, 2000])).toEqual([{ from: 0, to: 400, count: 5 }]);
  });

  it('간격이 벌어진 요청은 몰림이 아니다', () => {
    expect(findBursts([0, 600, 1200, 1800, 2400])).toEqual([]);
  });

  it('이어지는 몰림은 한 구간으로 합친다', () => {
    expect(findBursts([0, 100, 200, 300, 400, 500, 600, 700])).toEqual([{ from: 0, to: 700, count: 8 }]);
  });
});
