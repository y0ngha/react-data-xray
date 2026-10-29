import { describe, expect, it } from 'vitest';

import { renderAdvice } from '../advice.js';
import type { RenderGroup } from '../groups.js';
import { RENDER_REASONS, type RenderSummary } from '../types.js';

const base: RenderSummary = {
  recent: 1,
  last: 0,
  ms: 0,
  reasons: Object.fromEntries(RENDER_REASONS.map((r) => [r, 1])) as RenderSummary['reasons'],
  avoidable: 0,
  sameContentKeys: ['style'],
  callbackKeys: ['onClick'],
  contextKeys: ['Theme'],
  memoized: false,
  network: 0,
  causes: [],
  origins: [],
  stateHooks: [],
  compiled: false,
};
const group: RenderGroup = { ...base, name: 'X', instances: 1, fiber: {} };

describe('renderAdvice ko', () => {
  it('기본은 영어다', () => {
    const advice = renderAdvice(group).join('\n');
    expect(advice).toContain('useCallback');
    expect(advice).not.toMatch(/[가-힣]/);
  });

  it('ko 이면 한국어 조언을 낸다', () => {
    const advice = renderAdvice(group, 'ko').join('\n');
    expect(advice).toContain('useCallback 으로 감싸세요');
    expect(advice).toContain('useMemo 로 참조를 유지하거나');
    expect(advice).toContain('context');
    expect(advice).toMatch(/[가-힣]/);
  });

  it('ko timer: 초 단위로 표시하고 한국어 문구를 낸다', () => {
    const g: RenderGroup = {
      ...base,
      name: 'Timer',
      instances: 1,
      fiber: {},
      reasons: { ...base.reasons, state: 3, parent: 3, 'same-content': 0, 'new-callback': 0, context: 0 },
      origins: [{ name: 'Parent', reason: 'state', count: 3 }],
      stateHooks: [{ label: 'useState #1', count: 3, intervalMs: 2000, last: { from: '0', to: '1' } }],
    };
    const advice = renderAdvice(g, 'ko').join('\n');
    expect(advice).toContain('2.0초마다');
    expect(advice).toContain('타이머');
  });

  it('ko colocation: 하위 헛렌더 조언을 한국어로 낸다', () => {
    const g: RenderGroup = {
      ...base,
      name: 'Root',
      instances: 1,
      fiber: {},
      reasons: { ...base.reasons, state: 10, 'same-content': 0, 'new-callback': 0, context: 0, parent: 0 },
      stateHooks: [{ label: 'useState #1', count: 10, intervalMs: undefined, last: { from: '0', to: '1' } }],
      impact: { renders: 10, unchanged: 8, unchangedComponents: 3, changedProps: [] },
    };
    const advice = renderAdvice(g, 'ko').join('\n');
    expect(advice).toContain('state colocation');
    expect(advice).toContain('8회가 사라집니다');
  });
});
