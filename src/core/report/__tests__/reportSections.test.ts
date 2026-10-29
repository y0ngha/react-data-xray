import { describe, expect, it } from 'vitest';

import { buildReport } from '../buildReport.js';

// 섹션 파일로 나누기 전 howToRead 14줄. 내용과 순서를 고정한다.
const ORIGINAL_HOW_TO_READ: string[] = [
  'requests.endpoints is sorted by most waste (duplicates: same request within 2s, sameResponses: response identical to the previous one).',
  'review is repetition that may be intentional — polling, focus refetch — but should be checked.',
  'An endpoint with ignored: true was marked by the user as an expected repeat and is not counted as waste.',
  'The request totals include requests from before a same-tab page reload. Use restoredCount to distinguish pre- and post-reload requests.',
  'callers are resolved to original locations (src/…:line:col) via source maps. Lines that remain as http addresses have no source map and use transformed-code line numbers, which may be off — find them by function name instead.',
  'renders.components aggregates renders during renders.windowSeconds (up to 2 minutes after a reset, otherwise the last 10s), sorted by most avoidable renders. At most 200 renders per component are counted.',
  'When requests.dropped is greater than 0, the record limit (200) was exceeded and older requests were dropped. Split the scenario into shorter segments and measure again.',
  'reactQuery.findings lists queryKey design problems (duplicate cache, parameter missing from key, mismatched invalidation, staleTime 0). Follow the fix field.',
  "networkCauses.viaParent is the number of times this component re-rendered because an ancestor rendered due to a network response. The fix is usually that ancestor's setState.",
  "networkCauses.byTiming is the number of times this component's own state changed immediately after a response arrived (detected by timing, not by response object — the response was likely transformed before being stored).",
  'networkCauses.fromSameResponse is the number of renders triggered by a response identical to the previous one. Skip setState or use structural sharing when the response has not changed.',
  'causedBy is the ancestor that started the render (name and reason). renderedAt is the JSX location that renders this component.',
  'stateChanges lists the hooks (type #index) whose value changed when a state render occurred, along with the count, a regular interval (intervalMs, a timer signal), and the most recent change.',
  'startedRenders shows the impact of renders this component started on its children. When unchanged is large and changedProps is small, moving the changing state closer to the last component in changedProps is the fix (see the first line of advice).',
];

describe('보고서 섹션 분리', () => {
  it('how_to_read_order: howToRead 앞 14줄은 분리 전과 내용·순서가 같다', () => {
    // 이슈 작업이 더하는 줄(*_HOW_TO_READ_EXTRA)은 뒤에 붙으므로 앞 14줄만 본다.
    expect(buildReport(false, 0, false).howToRead.slice(0, ORIGINAL_HOW_TO_READ.length)).toEqual(ORIGINAL_HOW_TO_READ);
  });
});
