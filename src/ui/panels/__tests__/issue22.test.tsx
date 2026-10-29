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
  fireEvent.click(screen.getByText('Compare'));
  fireEvent.change(screen.getByLabelText('before'), { target: { value: 'before' } });
  fireEvent.change(screen.getByLabelText('after'), { target: { value: 'after' } });
  expect(screen.getByText(/duplicates -3/)).toBeTruthy();
  expect(screen.getByText(/measurement windows differ \(10s \/ 120s\)/)).toBeTruthy();
});
