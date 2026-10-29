import type { RequestRecord } from '../../../core/requests/types.js';
import { formatTime } from '../../../shared/format.js';
import { useRequestActions } from '../../contexts.js';
import { classColor, color } from '../../theme.js';
import type { BarLayout, TimelineLayout } from './timelineLayout.js';

interface TimelineChartProps {
  layout: TimelineLayout;
  hovered: RequestRecord | null;
  onHover: (bar: BarLayout | null) => void;
}

const BurstBand = ({ x, width, count, initial, height }: { x: number; width: number; count: number; initial: boolean; height: number }) => {
  // 페이지 진입 직후의 동시 요청은 흔하지만, 수십 건이 쏟아지는 것은 성능 문제일 수 있어 노랑(확인 필요)으로 둔다.
  const fill = initial ? color.review : color.warn;
  return (
    <g>
      <rect x={x} y={0} width={width} height={height - 14} fill={fill} opacity={initial ? 0.1 : 0.18} />
      <text x={x + 2} y={height - 16} fill={fill} fontSize={10}>
        {initial ? 'Initial burst' : 'Request burst'} ×{count}
      </text>
    </g>
  );
};

/** 요청 막대(호버하면 요약, 클릭하면 상세), 몰림 구간, 렌더 commit 눈금을 그린다. */
export const TimelineChart = ({ layout, hovered, onHover }: TimelineChartProps) => {
  const { open, classOf } = useRequestActions();
  const barFill = (record: RequestRecord) => {
    const c = classOf(record);
    return record.error ? color.failed : c === 'ok' ? color.accent : classColor(c);
  };
  return (
    <svg width={layout.width} height={layout.height} style={{ display: 'block', background: color.panel, borderRadius: 4 }}>
      <title>Network timeline</title>
      {layout.bursts.map((b) => (
        <BurstBand key={b.key} x={b.x} width={b.width} count={b.count} initial={b.initial} height={layout.height} />
      ))}
      {layout.bars.map((bar) => (
        <rect
          key={bar.record.id}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={layout.laneH}
          fill={barFill(bar.record)}
          stroke={hovered === bar.record ? '#fff' : undefined}
          style={{ cursor: 'pointer' }}
          onMouseEnter={() => onHover(bar)}
          onMouseLeave={() => onHover(null)}
          onClick={() => open(bar.record)}
        >
          <title>{`${bar.record.method} ${bar.record.url}`}</title>
        </rect>
      ))}
      <line x1={0} x2={layout.width} y1={layout.dividerY} y2={layout.dividerY} stroke={color.border} />
      {layout.commits.map((c) => (
        <rect key={c.key} x={c.x} y={layout.commitBaseY - c.height} width={2} height={c.height} fill={color.render}>
          <title>{`${formatTime(c.time)} · ${c.count} components rendered`}</title>
        </rect>
      ))}
      {layout.ticks.map((t) => (
        <text key={t.seconds} x={t.x} y={layout.height - 2} fill={color.muted} fontSize={9}>
          -{t.seconds}s
        </text>
      ))}
    </svg>
  );
};
