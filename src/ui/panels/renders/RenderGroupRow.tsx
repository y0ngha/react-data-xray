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
    {group.location && <span style={{ color: color.muted }}> · {group.location}</span>}
  </div>
);

/** 조상 때문에 렌더됐다면, 그 렌더를 시작한 조상. 고칠 곳은 대개 이 조상의 state 변경이다. */
const Origins = ({ group }: { group: RenderGroup }) =>
  group.origins.length > 0 ? (
    <Muted>렌더 시작: {group.origins.map((o) => `<${o.name}>(${REASON_LABEL[o.reason]}) ${o.count}회`).join(' · ')}</Muted>
  ) : null;

/** state 때문에 렌더됐다면 값이 바뀐 훅: 어느 훅이, 몇 번, 어떤 간격으로, 무엇에서 무엇으로 */
const StateHooks = ({ group }: { group: RenderGroup }) =>
  group.stateHooks.length > 0 ? (
    <Muted>
      바뀐 state:{' '}
      {group.stateHooks
        .map(
          (h) =>
            `${h.label} ${h.count}회${h.intervalMs ? ` (${(h.intervalMs / 1000).toFixed(1)}초마다)` : ''} · 최근 ${h.last.from} → ${h.last.to}`,
        )
        .join(' / ')}
    </Muted>
  ) : null;

/** 이 컴포넌트가 시작한 렌더가 하위에 미친 영향 */
const Impact = ({ group }: { group: RenderGroup }) =>
  group.impact ? (
    <Muted>
      이 컴포넌트가 일으킨 하위 렌더 {group.impact.renders}회 · 그중 값이 그대로 {group.impact.unchanged}회
      {group.impact.changedProps.length > 0 && ` · 값이 바뀐 props: ${group.impact.changedProps.join(' → ')}`}
    </Muted>
  ) : null;

/** 렌더는 네트워크와 무관할 수 있다. 응답 객체로 근거가 확인된 것만 네트워크 원인으로 보여 준다. */
const NetworkCauses = ({ group }: { group: RenderGroup }) => (
  <>
    <Muted>
      네트워크 응답으로 {group.network}회 · 네트워크와 무관 {group.recent - group.network}회
    </Muted>
    {group.causes.slice(0, 3).map((c) => (
      <RequestLink key={c.record.id} record={c.record}>
        <Muted>
          ⇠ <RequestTitle record={c.record} /> 응답으로 렌더 {c.direct + c.timing + c.parent}회
          {c.parent > 0 && ` (그중 부모를 따라 ${c.parent}회)`}
          {c.timing > 0 && ` · 그중 응답 직후 state 변경(시간으로 추정) ${c.timing}회`}
          {c.sameResponse > 0 && ` · 그중 직전과 같은 응답으로 ${c.sameResponse}회`} <ClassBadge record={c.record} />
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
    <StateHooks group={group} />
    <Impact group={group} />
    <Origins group={group} />
    {renderAdvice(group).map((text) => (
      <div key={text} style={{ color: color.review }}>
        · {text}
      </div>
    ))}
    <NetworkCauses group={group} />
    {source && <DataSource source={source} stat={stat} />}
  </div>
);
