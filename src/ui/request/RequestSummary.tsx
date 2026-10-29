import { pathOf } from '../../core/requests/requestKey.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { formatTime } from '../../shared/format.js';
import { color } from '../theme.js';

/** "GET /api/x" 한 줄 */
export const RequestTitle = ({ record }: { record: RequestRecord }) => (
  <u>
    {record.method} {pathOf(record.url)}
  </u>
);

/** "fetch · 200 · 120ms · 오후 3:00:00" 한 줄. 실패면 빨갛게 이유를 보여 준다. */
export const RequestStatusLine = ({ record }: { record: RequestRecord }) => (
  <div style={{ color: record.error || record.status >= 400 ? color.warn : color.muted }}>
    {record.kind} · {record.error ? `failed (${record.error})` : record.status} · {record.durationMs}ms · {formatTime(record.startedAt)}
    {record.restored && ' · before reload'}
  </div>
);
