import { pathOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { RequestParams } from '../../request/RequestParams.js';
import { RequestStatusLine } from '../../request/RequestSummary.js';
import { rowStyle } from '../../theme.js';

/** 요청 기록 한 줄. 누르면 요청 상세, 호버하면 쓰는 컴포넌트 강조 */
export const RequestLogRow = ({ record }: { record: RequestRecord }) => (
  <div style={rowStyle}>
    <RequestLink record={record}>
      <div style={{ display: 'flex', gap: 4, minWidth: 0 }}>
        {/* 경로는 한 줄로 말줄임한다. 쿼리는 아래 RequestParams 가 보인다 */}
        <u style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {record.method} {pathOf(record.url)}
        </u>
        <ClassBadge record={record} short />
      </div>
      <RequestStatusLine record={record} />
      <RequestParams record={record} />
    </RequestLink>
  </div>
);
