import type { LayoutShift } from '../../../core/render/layoutShifts.js';
import { pathOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { formatTime } from '../../../shared/format.js';
import { useRequestActions } from '../../contexts.js';
import { classColor, color } from '../../theme.js';
import type { BarLayout, TimelineLayout } from './timelineLayout.js';

interface TimelineChartProps {
  layout: TimelineLayout;
  hovered: RequestRecord | null;
  onHover: (bar: BarLayout | null) => void;
  /** 원인 요청이 있는 이동 표시를 눌렀을 때 */
  onShiftClick?: (shift: LayoutShift) => void;
}

// 패널이 여럿(팝업 창 포함) 떠도 같은 문서 안에서는 하나만 그려지므로 고정 id 로 둔다.
const ARROW_ID = 'rdx-waterfall-arrow';

const waterfallTitle = (from: RequestRecord, to: RequestRecord) =>
  `Waterfall: ${to.method} ${pathOf(to.url)}${to.component ? ` (sent by <${to.component}>)` : ''} waited for ${from.method} ${pathOf(from.url)} — its response mounted the sender`;

const burstLabel = (initial: boolean, count: number) => `${initial ? 'Screen entry burst' : 'Request burst'} ×${count}`;

/** 라벨 폭을 글자 수로 어림해(10px 글꼴 한 글자 약 6px) 앞 라벨과 겹치는 몰림 구간의 라벨은 그리지 않는다(구간 툴팁에는 남는다). */
export const visibleBurstLabels = (
  bursts: ReadonlyArray<{ x: number; width: number; count: number; initial: boolean }>,
  chartWidth: number,
): boolean[] => {
  let lastRight = -Infinity;
  return bursts.map((b) => {
    const w = burstLabel(b.initial, b.count).length * 6 + 4;
    const left = b.x > chartWidth / 2 ? b.x + b.width - w : b.x;
    if (left < lastRight) return false;
    lastRight = left + w;
    return true;
  });
};

const BurstBand = ({
  x,
  width,
  count,
  initial,
  height,
  chartWidth,
  showLabel,
}: {
  x: number;
  width: number;
  count: number;
  initial: boolean;
  height: number;
  chartWidth: number;
  showLabel: boolean;
}) => {
  // 페이지 진입 직후의 동시 요청은 흔하지만, 수십 건이 쏟아지는 것은 성능 문제일 수 있어 노랑(확인 필요)으로 둔다.
  const fill = initial ? color.review : color.warn;
  const label = burstLabel(initial, count);
  return (
    <g>
      <rect x={x} y={0} width={width} height={height - 14} fill={fill} opacity={initial ? 0.1 : 0.18}>
        <title>{label}</title>
      </rect>
      {/* 오른쪽 절반의 라벨은 구간 오른쪽 끝에 맞춰 차트 밖으로 잘리지 않게 한다 */}
      {showLabel && (
        <text
          x={x > chartWidth / 2 ? x + width - 2 : x + 2}
          y={height - 16}
          fill={fill}
          fontSize={10}
          textAnchor={x > chartWidth / 2 ? 'end' : 'start'}
        >
          {label}
        </text>
      )}
    </g>
  );
};

/** 이동 표시의 툴팁: 시각, 점수, 밀린 컴포넌트, 원인 응답과 그 응답으로 렌더된 컴포넌트 */
export const shiftLabel = (s: LayoutShift): string =>
  [
    `${formatTime(s.time)} · layout shift ${s.value.toFixed(3)}`,
    s.component ? `moved: <${s.component.name}>` : 'moved: unknown node',
    s.cause
      ? `${s.cause.inferred ? 'likely after' : 'after'} ${s.cause.endpoint} rendered <${s.cause.component}> (click for details)`
      : s.causeUnavailable
        ? 'cause unknown: render monitoring was off'
        : 'no network cause found',
  ].join(' · ');

/** 요청 막대(호버하면 요약, 클릭하면 상세), 워터폴 화살표, 몰림 구간, 렌더 commit 눈금, 레이아웃 이동(클릭하면 원인 요청 상세)을 그린다. */
export const TimelineChart = ({ layout, hovered, onHover, onShiftClick }: TimelineChartProps) => {
  const { open, classOf } = useRequestActions();
  const barFill = (record: RequestRecord) => {
    const c = classOf(record);
    return record.error ? color.failed : c === 'ok' ? color.accent : classColor(c);
  };
  const labels = visibleBurstLabels(layout.bursts, layout.width);
  return (
    <svg width={layout.width} height={layout.height} style={{ display: 'block', background: color.panel, borderRadius: 4 }}>
      <title>Network timeline</title>
      {layout.bursts.map((b, i) => (
        <BurstBand
          key={b.key}
          x={b.x}
          width={b.width}
          count={b.count}
          initial={b.initial}
          height={layout.height}
          chartWidth={layout.width}
          showLabel={labels[i]}
        />
      ))}
      {layout.links.length > 0 && (
        <defs>
          <marker id={ARROW_ID} viewBox="0 0 6 6" refX={6} refY={3} markerWidth={5} markerHeight={5} orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill={color.review} />
          </marker>
        </defs>
      )}
      {layout.links.map((l) => (
        <path
          key={l.key}
          // 앞 막대 끝에서 오른쪽으로 조금 나간 뒤 뒤 막대의 줄로 꺾어, 같은 줄이 아니어도 어느 막대로 가는지 보이게 한다.
          d={`M${l.x1},${l.y1} C${l.x1 + 8},${l.y1} ${l.x2 - 8},${l.y2} ${l.x2},${l.y2}`}
          fill="none"
          stroke={color.review}
          strokeWidth={1}
          markerEnd={`url(#${ARROW_ID})`}
          data-waterfall={`${l.from.id}-${l.to.id}`}
        >
          <title>{waterfallTitle(l.from, l.to)}</title>
        </path>
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
      {layout.shifts.map(({ key, x, height, shift }) => (
        <rect
          key={key}
          x={x - 1}
          y={layout.dividerY + 1}
          width={3}
          height={height}
          fill={color.shift}
          opacity={shift.cause?.inferred ? 0.55 : 1}
          style={shift.cause ? { cursor: 'pointer' } : undefined}
          onClick={shift.cause && onShiftClick ? () => onShiftClick(shift) : undefined}
        >
          <title>{shiftLabel(shift)}</title>
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
