import { Fragment } from 'react';

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

interface Segment {
  text: string;
  title?: string;
  color?: string;
  bold?: boolean;
}

/** 요약 줄의 조각들. 없는 지표는 뺀다. */
const segments = (stat: EndpointStat): Segment[] => {
  const all: Array<Segment | null> = [
    { text: `×${stat.count}` },
    { text: `avg ${stat.avgMs}ms` },
    stat.idVariants ? { text: `ID ${stat.idVariants} variants`, title: 'IDs in the path are grouped as :id' } : null,
    stat.restoredCount ? { text: `before reload: ${stat.restoredCount}`, title: 'Requests from the page before reload in this tab' } : null,
    stat.duplicates > 0 ? { text: `duplicates: ${stat.duplicates}`, color: color.warn } : null,
    stat.sameResponses > 0 ? { text: `same resp: ${stat.sameResponses}`, color: color.warn } : null,
    stat.failedDuplicates ? { text: `failed dup: ${stat.failedDuplicates}`, color: color.warn, bold: true } : null,
    stat.failedCodes
      ? { text: `failed: ${stat.failedCodes.join('·')}`, title: 'Status codes of failed requests regardless of waste' }
      : null,
    stat.review > 0 ? { text: `review: ${stat.review}`, color: color.review } : null,
    stat.explained > 0 ? { text: `expected: ${stat.explained}` } : null,
  ];
  return all.filter((seg): seg is Segment => seg !== null);
};

/** 엔드포인트 한 줄: 호출 수와 낭비 지표. 이름을 누르면 그 엔드포인트의 요청 목록으로 간다. */
export const EndpointRow = ({ stat, ignored, route, focus, onSelect, onToggleIgnore }: EndpointRowProps) => {
  const row = useReveal(focus);
  return (
    <div ref={row} tabIndex={-1} style={rowStyle}>
      <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
        <button
          type="button"
          title={stat.endpoint}
          onClick={() => onSelect(stat.endpoint)}
          style={{ ...plainButtonStyle, flex: 1, minWidth: 0, color: titleColor(stat, ignored) }}
        >
          {/* ellipsis 는 텍스트를 직접 담는 요소에 걸어야 한다 */}
          <u style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stat.endpoint}</u>
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
        {/* 조각 사이의 공백은 nowrap 밖에 두어 조각 사이에서만 줄이 바뀐다 */}
        {segments(stat).map((seg, i) => (
          <Fragment key={seg.text}>
            {i > 0 && ' · '}
            <span title={seg.title} style={{ whiteSpace: 'nowrap', color: seg.color, fontWeight: seg.bold ? 600 : undefined }}>
              {seg.text}
            </span>
          </Fragment>
        ))}
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
