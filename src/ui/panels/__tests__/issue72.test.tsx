import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { MAX_RENDER_GROUPS } from '../../../core/report/renderSection.js';
import { CompareReports } from '../compare/CompareReports.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, renders: 50 - i, avoidable: 40 - i }));

const rep = (dup: number, components: ReturnType<typeof rows>, omitted: number) => ({
  page: '/list',
  requests: { endpoints: [{ endpoint: 'GET /x', count: 5, duplicates: dup, sameResponses: 0 }] },
  renders: { monitoring: true, windowSeconds: 10, components, omitted: { components: omitted, renders: omitted, avoidable: 0 } },
  reactQuery: { findings: [], fetchCauses: [] },
});

it('패널 Compare 가 합계와 행별 판정을 보이고, 상한 밖으로 빠졌을 수 있는 행은 unknown 으로 보인다 (#72)', () => {
  const before = rep(4, rows(MAX_RENDER_GROUPS), 3);
  const after = rep(1, rows(MAX_RENDER_GROUPS - 1), 4);
  sessionStorage.setItem('rdx:snapshots', JSON.stringify({ before, after }));
  render(<CompareReports />);
  fireEvent.click(screen.getByText('Compare'));
  fireEvent.change(screen.getByLabelText('before'), { target: { value: 'before' } });
  fireEvent.change(screen.getByLabelText('after'), { target: { value: 'after' } });
  expect(screen.getByText(/wasted requests 4 → 1 \(-3, improved\)/)).toBeTruthy();
  expect(screen.getByText(/GET \/x \[improved\] duplicates -3/)).toBeTruthy();
  expect(screen.getByText(/<C29>\s+unknown \[unknown\]\s+\(before: renders 21 · avoidable 11\)/)).toBeTruthy();
  expect(screen.queryByText(/removed/)).toBeNull();
});
