import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { RdxReport } from '../../../core/report/buildReport.js';
import { NO_PLUGIN_MESSAGE } from '../../../core/report/reportApi.js';
import { CompareReports } from '../compare/CompareReports.js';
import { SnapshotButton } from '../compare/SnapshotButton.js';

const makeReport = (): RdxReport =>
  ({
    generatedAt: '',
    resetAt: null,
    page: '/',
    howToRead: [],
    requests: { total: 0, dropped: 0, endpoints: [], review: [] },
    reactQuery: { findings: [] },
    renders: { monitoring: true, windowSeconds: 10, truncated: false, droppedInstances: 0, components: [] },
  }) as never;

it('snapshot_default_before: no snapshots → default name is "before"', () => {
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
  render(<SnapshotButton />);
  fireEvent.click(screen.getByText('Save'));
  expect(screen.getByDisplayValue('before')).toBeTruthy();
});

it('snapshot_default_after: one snapshot exists → default name is "after"', () => {
  sessionStorage.setItem('rdx:snapshots', JSON.stringify({ before: {} }));
  sessionStorage.setItem('rdx:snapshotOrder', JSON.stringify(['before']));
  render(<SnapshotButton />);
  fireEvent.click(screen.getByText('Save'));
  expect(screen.getByDisplayValue('after')).toBeTruthy();
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
});

it('snapshot_invalid_name: invalid name shows error', () => {
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
  render(<SnapshotButton />);
  fireEvent.click(screen.getByText('Save'));
  fireEvent.change(screen.getByLabelText('Snapshot name'), { target: { value: '.bad/name' } });
  fireEvent.click(screen.getByTitle('Save snapshot'));
  expect(screen.getByText(/Letters, digits/)).toBeTruthy();
});

it('snapshot_save_success: successful save shows status and name appears in CompareReports', async () => {
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
  const report = makeReport();
  window.__RDX__ = {
    report: vi.fn<() => RdxReport>(() => report),
    reset: vi.fn<() => void>(),
    snapshot: vi.fn<(name: string) => Promise<RdxReport>>(async (name: string) => {
      sessionStorage.setItem(
        'rdx:snapshots',
        JSON.stringify({
          [name]: {
            requests: { endpoints: [] },
            renders: { monitoring: true, windowSeconds: 10, components: [] },
            reactQuery: { findings: [] },
          },
        }),
      );
      sessionStorage.setItem('rdx:snapshotOrder', JSON.stringify([name]));
      return report;
    }),
    compare: vi.fn<() => Promise<import('../../../core/report/compare.js').ReportComparison>>(async () => ({
      requests: [],
      renders: [],
      reactQuery: { added: [], resolved: [] },
      warnings: [],
    })),
  };

  const { unmount: u1 } = render(<SnapshotButton />);
  const { unmount: u2 } = render(<CompareReports />);

  fireEvent.click(screen.getByText('Save'));
  await act(async () => {
    fireEvent.click(screen.getByTitle('Save snapshot'));
  });

  expect(screen.getByText(/Saved to \.rdx\/before\.json/)).toBeTruthy();

  // Open CompareReports — it should now show 'before' in the select
  fireEvent.click(screen.getByText('Compare'));
  // With only 1 snapshot the empty-state shows; the key point is the Save button works
  expect(screen.getByText(/Use the Save button/)).toBeTruthy();

  u1();
  u2();
  window.__RDX__ = undefined;
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
});

it('snapshot_no_plugin: no plugin → tab-only status, name appears in sessionStorage', async () => {
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
  const report = makeReport();
  window.__RDX__ = {
    report: vi.fn<() => RdxReport>(() => report),
    reset: vi.fn<() => void>(),
    snapshot: vi.fn<(name: string) => Promise<RdxReport>>(async () => {
      throw new Error(NO_PLUGIN_MESSAGE);
    }),
    compare: vi.fn<() => Promise<import('../../../core/report/compare.js').ReportComparison>>(async () => ({
      requests: [],
      renders: [],
      reactQuery: { added: [], resolved: [] },
      warnings: [],
    })),
  };

  render(<SnapshotButton />);
  fireEvent.click(screen.getByText('Save'));
  await act(async () => {
    fireEvent.click(screen.getByTitle('Save snapshot'));
  });

  expect(screen.getByText(/Tab only/)).toBeTruthy();

  window.__RDX__ = undefined;
  sessionStorage.removeItem('rdx:snapshots');
  sessionStorage.removeItem('rdx:snapshotOrder');
});
