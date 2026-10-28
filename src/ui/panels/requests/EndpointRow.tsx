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
          title="이 엔드포인트의 요청 목록 보기"
          onClick={() => onSelect(stat.endpoint)}
          style={{ ...plainButtonStyle, flex: 1, color: titleColor(stat, ignored) }}
        >
          <u>{stat.endpoint}</u>
        </button>
        <Button
          subtle
          onClick={() => onToggleIgnore(stat.endpoint)}
          title="이 엔드포인트의 중복·같은 응답을 낭비로 세지 않습니다(의도된 동작일 때)"
        >
          {ignored ? '무시 해제' : '무시'}
        </Button>
      </div>
      <Muted>
        {stat.count}회 · 평균 {stat.avgMs}ms
        {stat.idVariants && <span title="경로 안의 ID 를 :id 로 묶었습니다"> · ID {stat.idVariants}종</span>}
        {!!stat.restoredCount && <span title="같은 탭에서 새로고침하기 전 페이지의 요청"> · 새로고침 전 {stat.restoredCount}</span>}
        {stat.duplicates > 0 && <span style={{ color: color.warn }}> · 중복 {stat.duplicates}</span>}
        {stat.sameResponses > 0 && <span style={{ color: color.warn }}> · 같은 응답 {stat.sameResponses}</span>}
        {!!stat.failedDuplicates && <span style={{ color: color.warn, fontWeight: 600 }}> · 실패 응답 {stat.failedDuplicates}</span>}
        {!!stat.failedCodes && <span title="낭비 여부와 무관하게 실패한 요청의 상태 코드"> · 실패 {stat.failedCodes.join('·')}</span>}
        {stat.review > 0 && <span style={{ color: color.review }}> · 확인 필요 {stat.review}</span>}
        {stat.explained > 0 && <span> · 정상 반복 {stat.explained}</span>}
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
