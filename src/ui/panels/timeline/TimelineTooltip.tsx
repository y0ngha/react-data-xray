import { pathOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestParams } from '../../request/RequestParams.js';
import { RequestStatusLine } from '../../request/RequestSummary.js';
import { color } from '../../theme.js';

const TOOLTIP_W = 300;

/** 막대에 호버했을 때 보이는 요청 요약 */
export const TimelineTooltip = ({ record, x, y, maxX }: { record: RequestRecord; x: number; y: number; maxX: number }) => (
  <div
    role="tooltip"
    style={{
      position: 'absolute',
      left: Math.min(x, maxX - TOOLTIP_W),
      top: y,
      width: TOOLTIP_W,
      padding: 6,
      background: '#000',
      border: `1px solid ${color.border}`,
      borderRadius: 4,
      pointerEvents: 'none',
      zIndex: 1,
    }}
  >
    <div>
      <b>{record.method}</b> {pathOf(record.url)}
    </div>
    <RequestStatusLine record={record} />
    <RequestParams record={record} />
    <ClassBadge record={record} />
    <div style={{ color: color.accent }}>Click for details</div>
  </div>
);
