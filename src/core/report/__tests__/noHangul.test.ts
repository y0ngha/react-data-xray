import { describe, expect, it } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { renderAdvice } from '../../render/advice.js';
import type { RenderGroup } from '../../render/groups.js';
import type { RenderSummary } from '../../render/types.js';
import { RENDER_REASONS } from '../../render/types.js';
import { buildReport } from '../buildReport.js';

describe('no_hangul', () => {
  it('report JSON has no Hangul characters', async () => {
    const load = () => fetch('/api/dup-nh?id=1').then((r) => r.json());
    await [0, 1].reduce((prev) => prev.then(load), Promise.resolve());
    await flush();
    const report = buildReport(false);
    expect(JSON.stringify(report)).not.toMatch(/[가-힣]/);
  });

  it('renderAdvice output has no Hangul characters', () => {
    const base: RenderSummary = {
      recent: 3,
      last: 0,
      ms: 0,
      reasons: { ...Object.fromEntries(RENDER_REASONS.map((r) => [r, 1])), state: 3 } as RenderSummary['reasons'],
      avoidable: 2,
      sameContentKeys: ['data'],
      callbackKeys: ['onSubmit'],
      contextKeys: ['Theme'],
      memoized: false,
      network: 0,
      causes: [],
      origins: [{ name: 'Parent', reason: 'state', count: 2 }],
      stateHooks: [{ label: 'useState #1', count: 3, intervalMs: 2000, last: { from: '0', to: '1' } }],
      compiled: false,
    };
    const group: RenderGroup = {
      ...base,
      name: 'Child',
      instances: 1,
      fiber: {},
      impact: { renders: 10, unchanged: 8, unchangedComponents: 3, changedProps: ['LeafA.value'] },
    };
    const advice = renderAdvice(group).join('\n');
    expect(advice).not.toMatch(/[가-힣]/);
  });
});
