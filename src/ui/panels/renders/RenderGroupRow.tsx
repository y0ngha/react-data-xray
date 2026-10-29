import { renderAdvice } from '../../../core/render/advice.js';
import type { RenderGroup } from '../../../core/render/groups.js';
import { WINDOW_MS, withHookPaths } from '../../../core/render/summary.js';
import { RENDER_REASONS, RENDER_STORM } from '../../../core/render/types.js';
import type { Hit } from '../../../core/inspect/types.js';
import type { EndpointStat } from '../../../core/requests/endpointStats.js';
import { Badge } from '../../components/Badge.js';
import { Muted } from '../../components/Muted.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { RequestTitle } from '../../request/RequestSummary.js';
import { useReveal } from '../../hooks/useReveal.js';
import type { FocusRequest } from '../../viewState.js';
import { color, rowStyle } from '../../theme.js';
import { REASON_LABEL } from './reasonLabels.js';

const reasonSummary = (g: RenderGroup): string =>
  RENDER_REASONS.filter((r) => g.reasons[r] > 0)
    .map((r) => `${REASON_LABEL[r]} ${g.reasons[r]}`)
    .join(' · ');

// RENDER_STORM 은 10초 기준이라, 더 긴 구간(reset 뒤 최대 120초)은 10초 몫으로 환산해 견준다.
const isStorm = (group: RenderGroup, windowMs: number): boolean =>
  group.recent / group.instances / Math.max(1, windowMs / WINDOW_MS) >= RENDER_STORM;

const Headline = ({ group, showTime, windowMs }: { group: RenderGroup; showTime: boolean; windowMs: number }) => (
  <div>
    <b style={{ color: isStorm(group, windowMs) ? color.warn : color.text }}>×{group.recent}</b>
    {showTime && <span style={{ color: color.muted }}> · {group.ms.toFixed(1)}ms</span>} &lt;{group.name}&gt;
    {group.instances > 1 && <span style={{ color: color.muted }}> × {group.instances}</span>}
    {group.avoidable > 0 && <Badge color={color.review}>avoidable {group.avoidable}</Badge>}
    {group.package && <Badge color={color.muted}>{group.package}</Badge>}
    {group.location && <span style={{ color: color.muted }}> · {group.location}</span>}
  </div>
);

/** 조상 때문에 렌더됐다면, 그 렌더를 시작한 조상. 고칠 곳은 대개 이 조상의 state 변경이다. */
const Origins = ({ group }: { group: RenderGroup }) =>
  group.origins.length > 0 ? (
    <Muted>started by: {group.origins.map((o) => `<${o.name}>(${REASON_LABEL[o.reason]}) ×${o.count}`).join(' · ')}</Muted>
  ) : null;

/** state 때문에 렌더됐다면 값이 바뀐 훅: 어느 훅이, 몇 번, 어떤 간격으로, 무엇에서 무엇으로 */
const StateHooks = ({ group }: { group: RenderGroup }) =>
  group.stateHooks.length > 0 ? (
    <Muted>
      state changed:{' '}
      {withHookPaths(group.stateHooks, group.fiber)
        .map(
          (h) =>
            `${h.label} ×${h.count}${h.intervalMs ? ` (every ${(h.intervalMs / 1000).toFixed(1)}s)` : ''} · latest ${h.last.from} → ${h.last.to}`,
        )
        .join(' / ')}
    </Muted>
  ) : null;

/** 이 컴포넌트가 시작한 렌더가 하위에 미친 영향 */
const Impact = ({ group }: { group: RenderGroup }) =>
  group.impact ? (
    <Muted>
      child renders triggered: ×{group.impact.renders} · unchanged: ×{group.impact.unchanged}
      {group.impact.changedProps.length > 0 && ` · changed props: ${group.impact.changedProps.join(' → ')}`}
    </Muted>
  ) : null;

/** memo 가 부모 렌더를 몇 번 건너뛰었고 몇 번 다시 렌더됐는지 */
const MemoStats = ({ group }: { group: RenderGroup }) =>
  group.memo ? (
    <Muted>
      memo: skipped ×{group.memo.skipped} · re-rendered ×{group.memo.rendered}
      {group.memo.neverSkippedProps.length > 0 && ` · always new ref: ${group.memo.neverSkippedProps.join(', ')}`}
    </Muted>
  ) : null;

/** 마운트·언마운트 횟수와 재마운트. 재마운트는 마운트 effect 의 요청·구독·타이머가 다시 도는 신호다. */
const Mounts = ({ group }: { group: RenderGroup }) =>
  group.mounts ? (
    <Muted>
      mount ×{group.mounts.mounts} · unmount ×{group.mounts.unmounts}
      {group.mounts.remounts.length > 0 &&
        ` · remount: ${group.mounts.remounts.map((r) => `${r.parent ? `under <${r.parent}> ` : ''}×${r.count}${r.cause ? ' (component type recreated each render)' : ''}`).join(' · ')}`}
    </Muted>
  ) : null;

/** 이 컴포넌트가 그린 라이브러리 내부 컴포넌트(축약된 이름이라 패키지와 함께 보여 준다) */
const Libraries = ({ group }: { group: RenderGroup }) =>
  group.libraries?.length ? (
    <Muted>
      inner libraries:{' '}
      {group.libraries
        .map((l) => `${l.package} <${l.name}> ×${l.renders}${l.avoidable > 0 ? ` (avoidable ${l.avoidable})` : ''}`)
        .join(' · ')}
    </Muted>
  ) : null;

/** 렌더는 네트워크와 무관할 수 있다. 응답 객체로 근거가 확인된 것만 네트워크 원인으로 보여 준다. */
const NetworkCauses = ({ group }: { group: RenderGroup }) => (
  <>
    <Muted>
      by network response: ×{group.network} · unrelated to network: ×{group.recent - group.network}
    </Muted>
    {group.causes.slice(0, 3).map((c) => (
      <RequestLink key={c.record.id} record={c.record}>
        <Muted>
          ⇠ <RequestTitle record={c.record} /> rendered on response ×{c.direct + c.timing + c.parent}
          {c.parent > 0 && ` (via parent ×${c.parent})`}
          {c.timing > 0 && ` · state change after response (by timing) ×${c.timing}`}
          {c.sameResponse > 0 && ` · same response ×${c.sameResponse}`} <ClassBadge record={c.record} />
        </Muted>
      </RequestLink>
    ))}
  </>
);

/** 데이터 출처 요청과, 그 엔드포인트의 낭비 지표(같은 엔드포인트가 반복 호출돼 렌더가 잦을 수 있다) */
const DataSource = ({ source, stat }: { source: Hit; stat?: EndpointStat }) => (
  <RequestLink record={source.record}>
    <Muted>
      data source ← <RequestTitle record={source.record} /> <ClassBadge record={source.record} />
      {stat && stat.duplicates > 0 && <Badge color={color.warn}>duplicates {stat.duplicates}</Badge>}
      {stat && stat.sameResponses > 0 && <Badge color={color.warn}>same response {stat.sameResponses}</Badge>}
    </Muted>
  </RequestLink>
);

interface RenderGroupRowProps {
  group: RenderGroup;
  source?: Hit;
  stat?: EndpointStat;
  showTime: boolean;
  /** 렌더를 센 구간(ms). 폭주 색을 10초 기준으로 환산하는 데 쓴다. */
  windowMs?: number;
  /** 배지 내역에서 이 줄로 오라는 요청 */
  focus?: FocusRequest;
}

/** 렌더 분석 한 줄: 횟수·시간·이유, 줄이는 방법, 네트워크 원인, 데이터 출처 */
export const RenderGroupRow = ({ group, source, stat, showTime, windowMs = WINDOW_MS, focus }: RenderGroupRowProps) => {
  const row = useReveal(focus);
  return (
    <div ref={row} tabIndex={-1} style={rowStyle}>
      <Headline group={group} showTime={showTime} windowMs={windowMs} />
      <Muted>{reasonSummary(group)}</Muted>
      <MemoStats group={group} />
      <Mounts group={group} />
      <Libraries group={group} />
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
};
