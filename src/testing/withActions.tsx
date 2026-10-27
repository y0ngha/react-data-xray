import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import type { RequestClass } from '../core/requests/classify.js';
import type { RequestRecord } from '../core/requests/types.js';
import { RequestActionsProvider, type RequestActions } from '../ui/contexts.js';

/** 요청 동작(열기·호버·분류)을 가짜로 꽂아 컴포넌트를 그린다. */
export const renderWithActions = (
  ui: ReactElement,
  classOf: (r: RequestRecord) => RequestClass = () => 'ok',
): RenderResult & { actions: RequestActions } => {
  const actions: RequestActions = {
    open: vi.fn<RequestActions['open']>(),
    hover: vi.fn<RequestActions['hover']>(),
    classOf,
  };
  return { actions, ...render(<RequestActionsProvider value={actions}>{ui}</RequestActionsProvider>) };
};
