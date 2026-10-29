import type { ReactNode } from 'react';

import type { RequestRecord } from '../../core/requests/types.js';
import { useRequestActions, type Focus } from '../contexts.js';
import { plainButtonStyle } from '../theme.js';

/**
 * 감싼 내용을 누르면 그 요청의 상세 화면을 열고,
 * 호버(키보드 포커스)하면 이 요청의 데이터를 쓰는 컴포넌트를 화면에서 강조한다.
 */
export const RequestLink = ({ record, focus, children }: { record: RequestRecord; focus?: Focus; children: ReactNode }) => {
  const { open, hover } = useRequestActions();
  return (
    <button
      type="button"
      title="Click to see request details (headers, Request/Response Body)"
      onClick={() => open(record, focus)}
      onMouseEnter={() => hover(record)}
      onMouseLeave={() => hover(null)}
      onFocus={() => hover(record)}
      onBlur={() => hover(null)}
      style={plainButtonStyle}
    >
      {children}
    </button>
  );
};
