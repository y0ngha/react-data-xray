import { renderAdvice } from '../../../core/render/advice.js';
import type { RenderGroup } from '../../../core/render/groups.js';
import { RENDER_REASONS } from '../../../core/render/types.js';
import type { Hit } from '../../../core/inspect/types.js';
import { Badge } from '../../components/Badge.js';
import { Muted } from '../../components/Muted.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { RequestTitle } from '../../request/RequestSummary.js';
import { color, rowStyle } from '../../theme.js';
import { REASON_LABEL } from './reasonLabels.js';

// 최근 10초에 인스턴스 하나가 이만큼 넘게 렌더되면 렌더 폭주로 본다.
const RENDER_STORM = 10;

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

/** 렌더 분석 한 줄: 횟수·시간·이유, 줄이는 방법, 네트워크 원인, 데이터 출처 */
export const RenderGroupRow = ({ group, source, showTime }: { group: RenderGroup; source?: Hit; showTime: boolean }) => (
  <div style={rowStyle}>
    <Headline group={group} showTime={showTime} />
    <Muted>{reasonSummary(group)}</Muted>
    {renderAdvice(group).map((text) => (
      <div key={text} style={{ color: color.review }}>
        · {text}
      </div>
    ))}
    <NetworkCauses group={group} />
    {source && (
      <RequestLink record={source.record}>
        <Muted>
          데이터 출처 ← <RequestTitle record={source.record} /> <ClassBadge record={source.record} />
        </Muted>
      </RequestLink>
    )}
  </div>
);
