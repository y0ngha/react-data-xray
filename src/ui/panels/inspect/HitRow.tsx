import type { EndpointStat } from '../../../core/requests/endpointStats.js';
import { isWastefulStat } from '../../../core/requests/endpointStats.js';
import type { Hit } from '../../../core/inspect/types.js';
import { formatJson, valueAt } from '../../../shared/format.js';
import { Badge } from '../../components/Badge.js';
import { Muted } from '../../components/Muted.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { RequestParams } from '../../request/RequestParams.js';
import { RequestStatusLine, RequestTitle } from '../../request/RequestSummary.js';
import { color, MATCH_COLOR, MATCH_LABEL, rowStyle } from '../../theme.js';

/** 검사 결과 한 줄: 어느 요청의 어느 위치를 어떤 props·훅으로 들고 있는지. 누르면 요청 상세가 열린다. */
export const HitRow = ({ hit, stat }: { hit: Hit; stat?: EndpointStat }) => (
  <div style={{ ...rowStyle, padding: '6px 0' }}>
    <RequestLink record={hit.record} focus={{ path: hit.path, via: hit.via }}>
      <div>
        <Badge color={MATCH_COLOR[hit.match]}>{MATCH_LABEL[hit.match]}</Badge>
        <RequestTitle record={hit.record} />
      </div>
      <RequestStatusLine record={hit.record} />
      <RequestParams record={hit.record} />
      <div>
        <ClassBadge record={hit.record} />
        {stat && stat.count > 1 && <Badge color={isWastefulStat(stat) ? color.warn : color.muted}>×{stat.count} calls</Badge>}
      </div>
      <div>
        path: <code>{hit.path}</code> ← <code>{hit.via}</code>
      </div>
      {hit.queryKey !== undefined && (
        <div>
          queryKey: <code>{formatJson(hit.queryKey)}</code>
        </div>
      )}
      <Muted>value: {formatJson(valueAt(hit.record.body, hit.path))}</Muted>
      <div style={{ color: color.accent }}>Click to see request detail and full value</div>
    </RequestLink>
  </div>
);
