import { describe, expect, it } from 'vitest';

import { compare, type ComparableReport } from '../compare.js';

const make = (windowSeconds: number, monitoring: boolean): ComparableReport => ({
  requests: { endpoints: [] },
  renders: { monitoring, windowSeconds, components: [] },
  reactQuery: { findings: [] },
});

describe('compare warnings ko', () => {
  it('기본(lang 없음)은 영어 경고를 낸다', () => {
    const result = compare(make(10, false), make(30, false));
    expect(result.warnings.join()).toContain('measurement windows differ');
    expect(result.warnings.join()).not.toMatch(/[가-힣]/);
  });

  it('ko 이면 한국어 경고를 낸다', () => {
    const result = compare(make(10, false), make(30, false), 'ko');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('측정 구간이 다르다');
    expect(result.warnings[1]).toContain('렌더 비교는 믿기 어렵다');
  });
});
