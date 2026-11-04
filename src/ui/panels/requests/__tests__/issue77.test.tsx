import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { classifyRecords } from '../../../../core/requests/classify.js';
import { getEndpointStats } from '../../../../core/requests/endpointStats.js';
import { createRecord, finishRecord } from '../../../../core/requests/store.js';
import { renderWithActions } from '../../../../testing/withActions.js';
import { RequestsTab } from '../RequestsTab.js';

describe('RequestsTab 무시 목록의 보이지 않는 키 (#77)', () => {
  it('지금 엔드포인트와 맞지 않는 무시 키(옛 POST /graphql)를 보여 주고 지울 수 있다', () => {
    const r = createRecord('fetch', 'POST', '/graphql', '{"operationName":"GetUser","query":"query GetUser { me }"}');
    finishRecord(r, 200);
    const records = [r];
    const stats = getEndpointStats(records, classifyRecords(records, new Set()));
    const onToggleIgnore = vi.fn<(endpoint: string) => void>();
    const ignored = new Set(['POST /graphql', 'POST /graphql (GetUser)']);
    renderWithActions(<RequestsTab records={records} stats={stats} ignored={ignored} onToggleIgnore={onToggleIgnore} />);
    expect(screen.getByText('Ignored but not seen in current requests')).toBeTruthy();
    // 지금 줄이 있는 키는 그 줄의 Unignore 로 풀므로 목록에 없다.
    expect(screen.getByText('POST /graphql')).toBeTruthy();
    expect(screen.getAllByText('POST /graphql (GetUser)')).toHaveLength(1);
    fireEvent.click(screen.getByText('Remove'));
    expect(onToggleIgnore).toHaveBeenCalledWith('POST /graphql');
  });
});
