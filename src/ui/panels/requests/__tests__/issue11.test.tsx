import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { classifyRecords } from '../../../../core/requests/classify.js';
import { getEndpointStats } from '../../../../core/requests/endpointStats.js';
import { createRecord, finishRecord } from '../../../../core/requests/store.js';
import { renderWithActions } from '../../../../testing/withActions.js';
import { RequestsTab } from '../RequestsTab.js';

const made = (url: string, restored: boolean) => {
  const r = createRecord('fetch', 'GET', url);
  finishRecord(r, 200);
  r.restored = restored || undefined;
  return r;
};

describe('엔드포인트 줄의 새로고침 전 수 (#11)', () => {
  it('restoredCount 가 0 보다 클 때만 "새로고침 전 N" 을 보인다', () => {
    const records = [made('/api/r', true), made('/api/r', true), made('/api/r', false), made('/api/n', false)];
    const stats = getEndpointStats(records, classifyRecords(records, new Set()));
    expect(stats.find((s) => s.endpoint === 'GET /api/r')?.restoredCount).toBe(2);
    renderWithActions(
      <RequestsTab records={records} stats={stats} ignored={new Set()} onToggleIgnore={vi.fn<(endpoint: string) => void>()} />,
    );
    expect(screen.getAllByText(/before reload:/)).toHaveLength(1);
    expect(screen.getByText(/before reload: 2/)).toBeTruthy();
  });
});
