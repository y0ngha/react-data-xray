import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EndpointStat } from '../../../../core/requests/endpointStats.js';
import { getEndpointStats } from '../../../../core/requests/endpointStats.js';
import { createRecord, finishRecord } from '../../../../core/requests/store.js';
import { renderWithActions } from '../../../../testing/withActions.js';
import { EndpointRow } from '../EndpointRow.js';
import { RequestsTab } from '../RequestsTab.js';

const row = (stat: Partial<EndpointStat>, route?: string) =>
  renderWithActions(
    <EndpointRow
      stat={{ endpoint: 'GET /a', count: 2, duplicates: 0, sameResponses: 0, review: 0, explained: 0, avgMs: 5, ...stat }}
      ignored={false}
      route={route}
      onSelect={vi.fn<(e: string) => void>()}
      onToggleIgnore={vi.fn<(e: string) => void>()}
    />,
  );

describe('EndpointRow (PR2-6)', () => {
  it('경로 필터가 없고 site 가 하나뿐이면 site 줄을 그리지 않는다', () => {
    row({ sites: [{ route: '/only', component: 'Solo', count: 2 }] });
    expect(screen.queryByText(/Solo/)).toBeNull();
  });

  it('경로 필터가 없어도 site 가 둘 이상이면 모두 그린다', () => {
    row({
      sites: [
        { route: '/a', component: 'A', count: 1 },
        { route: '/b', component: 'B', count: 1 },
      ],
    });
    expect(screen.getByText(/<A>/)).toBeTruthy();
    expect(screen.getByText(/<B>/)).toBeTruthy();
  });

  it('실패 코드는 중복 표기와 따로 보인다', () => {
    row({ failedCodes: ['503', 'ERR'] });
    expect(screen.getByText(/실패 503·ERR/)).toBeTruthy();
    expect(screen.queryByText(/실패 응답/)).toBeNull();
  });
});

describe('RequestsTab 지금 경로만 (PR2-7)', () => {
  it('행의 건수도 그 경로에서 보낸 것만 센다', () => {
    const sent = (route: string) => {
      const r = createRecord('fetch', 'GET', '/api/count');
      r.route = route;
      finishRecord(r, 200);
      return r;
    };
    const records = [sent('/mine'), sent('/mine'), sent('/other'), sent('/other'), sent('/other')];
    history.pushState({}, '', '/mine');
    renderWithActions(
      <RequestsTab
        records={records}
        stats={getEndpointStats(records, new Map())}
        ignored={new Set()}
        onToggleIgnore={vi.fn<(e: string) => void>()}
      />,
    );
    expect(screen.getByText(/5회/)).toBeTruthy();
    fireEvent.click(screen.getByText('지금 경로만'));
    expect(screen.getByText(/2회/)).toBeTruthy();
    expect(screen.queryByText(/5회/)).toBeNull();
  });
});
