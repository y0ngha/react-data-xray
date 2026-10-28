import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { CompareReports } from '../compare/CompareReports.js';

const rep = (dup: number, win: number) => ({
  requests: { endpoints: [{ endpoint: 'GET /x', count: 5, duplicates: dup, sameResponses: 0 }] },
  renders: { monitoring: true, windowSeconds: win, components: [] },
  reactQuery: { findings: [] },
});

it('패널에서 두 스냅샷을 골라 비교한다', () => {
  sessionStorage.setItem('rdx:snapshots', JSON.stringify({ before: rep(4, 10), after: rep(1, 120) }));
  render(<CompareReports />);
  fireEvent.click(screen.getByText('비교'));
  fireEvent.change(screen.getByLabelText('전'), { target: { value: 'before' } });
  fireEvent.change(screen.getByLabelText('후'), { target: { value: 'after' } });
  expect(screen.getByText(/duplicates -3/)).toBeTruthy();
  expect(screen.getByText(/측정 구간이 다르다 \(10초 \/ 120초\)/)).toBeTruthy();
});
