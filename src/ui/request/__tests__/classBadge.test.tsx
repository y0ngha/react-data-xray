// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { pinReason } from '../../../core/reactQuery/refetchReason.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { renderWithActions } from '../../../testing/withActions.js';
import { RequestActionsProvider } from '../../contexts.js';
import { ClassBadge } from '../ClassBadge.js';

describe('ClassBadge', () => {
  it('staleTime 0 표기는 유휴 큐가 고정한 원인만 읽는다', () => {
    const record = {
      id: 1,
      kind: 'fetch',
      method: 'GET',
      url: '/a',
      status: 200,
      startedAt: 0,
      durationMs: 1,
    } as RequestRecord;
    const view = renderWithActions(<ClassBadge record={record} />, () => 'same-response');
    expect(view.container.textContent).not.toContain('staleTime 0');
    pinReason(record, 'stale-zero');
    view.rerender(
      <RequestActionsProvider value={view.actions}>
        <ClassBadge record={record} />
      </RequestActionsProvider>,
    );
    expect(view.container.textContent).toContain('staleTime 0');
  });
});
