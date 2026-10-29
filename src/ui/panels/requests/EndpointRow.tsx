import { isWastefulStat, type EndpointStat } from '../../../core/requests/endpointStats.js';
import { useReveal } from '../../hooks/useReveal.js';
import type { FocusRequest } from '../../viewState.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';
import { color, plainButtonStyle, rowStyle } from '../../theme.js';

interface EndpointRowProps {
  stat: EndpointStat;
  ignored: boolean;
  /** 주면 이 경로에서 보낸 건수만 보인다 */
  route?: string;
  /** 배지 내역에서 이 줄로 오라는 요청 */
  focus?: FocusRequest;
  onSelect: (endpoint: string) => void;
  onToggleIgnore: (endpoint: string) => void;
}

const MAX_SITES = 5;

/** 경로·컴포넌트별 건수. 한 곳뿐이면 줄 하나가 엔드포인트와 같은 말이라 route 로 거를 때만 보인다 */
const sitesShown = (stat: EndpointStat, route: string | undefined) => {
  const sites = (stat.sites ?? []).filter((site) => route === undefined || site.route === route);
  return route === undefined && sites.length <= 1 ? [] : sites.slice(0, MAX_SITES);
};

const titleColor = (stat: EndpointStat, ignored: boolean) => (isWastefulStat(stat) ? color.warn : ignored ? color.muted : color.text);

/** 엔드포인트 한 줄: 호출 수와 낭비 지표. 이름을 누르면 그 엔드포인트의 요청 목록으로 간다. */
export const EndpointRow = ({ stat, ignored, route, focus, onSelect, onToggleIgnore }: EndpointRowProps) => {
  const row = useReveal(focus);
  return (
    <div ref={row} tabIndex={-1} style={rowStyle}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          title="View request list for this endpoint"
          onClick={() => onSelect(stat.endpoint)}
          style={{ ...plainButtonStyle, flex: 1, color: titleColor(stat, ignored) }}
        >
          <u>{stat.endpoint}</u>
        </button>
        <Button
          subtle
          onClick={() => onToggleIgnore(stat.endpoint)}
          title="Do not count duplicates and same responses as waste for this endpoint (when intentional)"
        >
          {ignored ? 'Unignore' : 'Ignore'}
        </Button>
      </div>
      <Muted>
        ×{stat.count} · avg {stat.avgMs}ms
        {stat.idVariants && <span title="IDs in the path are grouped as :id"> · ID {stat.idVariants} variants</span>}
        {!!stat.restoredCount && (
          <span title="Requests from the page before reload in this tab"> · before reload: {stat.restoredCount}</span>
        )}
        {stat.duplicates > 0 && <span style={{ color: color.warn }}> · duplicates: {stat.duplicates}</span>}
        {stat.sameResponses > 0 && <span style={{ color: color.warn }}> · same resp: {stat.sameResponses}</span>}
        {!!stat.failedDuplicates && <span style={{ color: color.warn, fontWeight: 600 }}> · failed dup: {stat.failedDuplicates}</span>}
        {!!stat.failedCodes && (
          <span title="Status codes of failed requests regardless of waste"> · failed: {stat.failedCodes.join('·')}</span>
        )}
        {stat.review > 0 && <span style={{ color: color.review }}> · review: {stat.review}</span>}
        {stat.explained > 0 && <span> · expected: {stat.explained}</span>}
      </Muted>
      {sitesShown(stat, route).map((site) => (
        <Muted key={`${site.route}|${site.component}`}>
          {'  '}
          {site.route ?? '?'} {site.component ? `<${site.component}>` : ''} {site.count}
        </Muted>
      ))}
    </div>
  );
};
