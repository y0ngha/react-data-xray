import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { classifyRecords } from '../../../../core/requests/classify.js';
import { getEndpointStats } from '../../../../core/requests/endpointStats.js';
import { createRecord, finishRecord } from '../../../../core/requests/store.js';
import { renderWithActions } from '../../../../testing/withActions.js';
import { RequestsTab } from '../RequestsTab.js';

const sent = (url: string, route: string, component?: string) => {
  const r = createRecord('fetch', 'GET', url);
  r.route = route;
  r.component = component;
  finishRecord(r, 200);
  return r;
};

describe('RequestsTab 경로·컴포넌트 (#12)', () => {
  const records = [
    sent('/api/s', '/projects', 'SummaryCard'),
    sent('/api/s', '/projects', 'SummaryCard'),
    sent('/api/s', '/dashboard', 'SummaryWidget'),
  ];
  const stats = getEndpointStats(records, classifyRecords(records, new Set()));
  const tab = () =>
    renderWithActions(
      <RequestsTab records={records} stats={stats} ignored={new Set()} onToggleIgnore={vi.fn<(endpoint: string) => void>()} />,
    );

  it('엔드포인트 줄에 경로·컴포넌트별 건수가 보인다', () => {
    tab();
    expect(screen.getByText(/\/projects\s+<SummaryCard>\s+2/)).toBeTruthy();
    expect(screen.getByText(/\/dashboard\s+<SummaryWidget>\s+1/)).toBeTruthy();
  });

  it('current_route_filter: 지금 경로만 보면 그 경로의 요청만 남는다', () => {
    history.pushState({}, '', '/projects');
    tab();
    fireEvent.click(screen.getByText('This route'));
    expect(screen.queryByText(/SummaryWidget/)).toBeNull();
    expect(screen.getByText(/SummaryCard/)).toBeTruthy();
    fireEvent.click(screen.getByText('All requests'));
    expect(screen.getAllByText(/GET \/api\/s/).length).toBe(2);
  });
});
