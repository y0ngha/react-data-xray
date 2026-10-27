import type { RequestRecord } from '../../../core/requests/types.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { RequestParams } from '../../request/RequestParams.js';
import { RequestStatusLine, RequestTitle } from '../../request/RequestSummary.js';
import { rowStyle } from '../../theme.js';

/** 요청 기록 한 줄. 누르면 요청 상세, 호버하면 쓰는 컴포넌트 강조 */
export const RequestLogRow = ({ record }: { record: RequestRecord }) => (
  <div style={rowStyle}>
    <RequestLink record={record}>
      <div>
        <RequestTitle record={record} /> <ClassBadge record={record} short />
      </div>
      <RequestStatusLine record={record} />
      <RequestParams record={record} />
    </RequestLink>
  </div>
);
