import { renderAdvice } from '../../../core/render/advice.js';
import type { RenderGroup } from '../../../core/render/groups.js';
import { RENDER_REASONS, RENDER_STORM } from '../../../core/render/types.js';
import type { Hit } from '../../../core/inspect/types.js';
import type { EndpointStat } from '../../../core/requests/endpointStats.js';
import { Badge } from '../../components/Badge.js';
import { Muted } from '../../components/Muted.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { RequestTitle } from '../../request/RequestSummary.js';
import { color, rowStyle } from '../../theme.js';
import { REASON_LABEL } from './reasonLabels.js';

const reasonSummary = (g: RenderGroup): string =>
  RENDER_REASONS.filter((r) => g.reasons[r] > 0)
    .map((r) => `${REASON_LABEL[r]} ${g.reasons[r]}`)
    .join(' · ');

const Headline = ({ group, showTime }: { group: RenderGroup; showTime: boolean }) => (
  <div>
    <b style={{ color: group.recent / group.instances >= RENDER_STORM ? color.warn : color.text }}>{group.recent}회</b>
    {showTime && <span style={{ color: color.muted }}> · {group.ms.toFixed(1)}ms</span>} &lt;{group.name}&gt;
    {group.instances > 1 && <span style={{ color: color.muted }}> × {group.instances}개</span>}
    {group.avoidable > 0 && <Badge color={color.review}>줄일 수 있음 {group.avoidable}</Badge>}
  </div>
);

/** 렌더는 네트워크와 무관할 수 있다. 응답 객체로 근거가 확인된 것만 네트워크 원인으로 보여 준다. */
const NetworkCauses = ({ group }: { group: RenderGroup }) => (
  <>
    <Muted>
      네트워크 응답으로 {group.network}회 · 네트워크와 무관 {group.recent - group.network}회
    </Muted>
    {group.causes.slice(0, 3).map((c) => (
      <RequestLink key={c.record.id} record={c.record}>
        <Muted>
          ⇠ <RequestTitle record={c.record} /> 응답으로 렌더 {c.direct + c.parent}회{c.parent > 0 && ` (그중 부모를 따라 ${c.parent}회)`}{' '}
          <ClassBadge record={c.record} />
        </Muted>
      </RequestLink>
    ))}
  </>
);

/** 데이터 출처 요청과, 그 엔드포인트의 낭비 지표(같은 엔드포인트가 반복 호출돼 렌더가 잦을 수 있다) */
const DataSource = ({ source, stat }: { source: Hit; stat?: EndpointStat }) => (
  <RequestLink record={source.record}>
    <Muted>
      데이터 출처 ← <RequestTitle record={source.record} /> <ClassBadge record={source.record} />
      {stat && stat.duplicates > 0 && <Badge color={color.warn}>중복 {stat.duplicates}</Badge>}
      {stat && stat.sameResponses > 0 && <Badge color={color.warn}>같은 응답 {stat.sameResponses}</Badge>}
    </Muted>
  </RequestLink>
);

interface RenderGroupRowProps {
  group: RenderGroup;
  source?: Hit;
  stat?: EndpointStat;
  showTime: boolean;
}

/** 렌더 분석 한 줄: 횟수·시간·이유, 줄이는 방법, 네트워크 원인, 데이터 출처 */
export const RenderGroupRow = ({ group, source, stat, showTime }: RenderGroupRowProps) => (
  <div style={rowStyle}>
    <Headline group={group} showTime={showTime} />
    <Muted>{reasonSummary(group)}</Muted>
    {renderAdvice(group).map((text) => (
      <div key={text} style={{ color: color.review }}>
        · {text}
      </div>
    ))}
    <NetworkCauses group={group} />
    {source && <DataSource source={source} stat={stat} />}
  </div>
);
