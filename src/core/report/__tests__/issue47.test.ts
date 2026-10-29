import { describe, expect, it } from 'vitest';

import { buildReport } from '../buildReport.js';
import { compare, toComparable } from '../compare.js';
import type { ComparableReport } from '../compare.js';

const base = (): ComparableReport => ({
  requests: { endpoints: [] },
  renders: { monitoring: true, windowSeconds: 10, components: [] },
  reactQuery: { findings: [] },
});

describe('resetAt in report', () => {
  it('report_resetAt_null: resetAt is null before reset', () => {
    sessionStorage.removeItem('rdx:resetAt');
    expect(buildReport(false, 0, false).resetAt).toBeNull();
  });

  it('report_resetAt_number: resetAt is the written value after reset', () => {
    sessionStorage.setItem('rdx:resetAt', JSON.stringify(12345));
    expect(buildReport(false, 0, false).resetAt).toBe(12345);
    sessionStorage.removeItem('rdx:resetAt');
  });

  it('report_resetAt_howToRead: howToRead contains resetAt line at the end', () => {
    const { howToRead } = buildReport(false, 0, false);
    const last = howToRead[howToRead.length - 1];
    expect(last).toContain('resetAt');
    expect(last).toContain('reset()');
  });
});

describe('compare resetAt warning', () => {
  it('compare_both_null: no warning when neither report was reset', () => {
    const r = compare({ ...base(), resetAt: null }, { ...base(), resetAt: null });
    expect(r.warnings.some((w) => w.includes('reset'))).toBe(false);
  });

  it('compare_both_set: no warning when both were reset', () => {
    const r = compare({ ...base(), resetAt: 1000 }, { ...base(), resetAt: 2000 });
    expect(r.warnings.some((w) => w.includes('only one report'))).toBe(false);
  });

  it('compare_only_after_reset: warns when only after has resetAt', () => {
    const r = compare({ ...base(), resetAt: null }, { ...base(), resetAt: 1_700_000_000_000 });
    expect(r.warnings.some((w) => w.includes('only one report was measured after a reset'))).toBe(true);
  });

  it('compare_only_before_reset: warns when only before has resetAt', () => {
    const r = compare({ ...base(), resetAt: 1_700_000_000_000 }, { ...base(), resetAt: null });
    expect(r.warnings.some((w) => w.includes('only one report was measured after a reset'))).toBe(true);
  });

  it('compare_missing_resetAt: old snapshot without resetAt field treated as null', () => {
    const old = base(); // no resetAt field — ComparableReport.resetAt is optional
    const r = compare(old, { ...base(), resetAt: 1_700_000_000_000 });
    expect(r.warnings.some((w) => w.includes('only one report'))).toBe(true);
  });
});

describe('toComparable carries resetAt', () => {
  it('toComparable_preserves_resetAt', () => {
    const rpt = {
      generatedAt: '',
      resetAt: 9999,
      page: '/',
      howToRead: [],
      requests: { total: 0, dropped: 0, endpoints: [], review: [] },
      reactQuery: { findings: [] },
      renders: { monitoring: true, windowSeconds: 0, truncated: false, droppedInstances: 0, components: [] },
    };
    expect(toComparable(rpt as never).resetAt).toBe(9999);
  });
});
