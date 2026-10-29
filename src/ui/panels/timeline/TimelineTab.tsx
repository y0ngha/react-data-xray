import { useRef, useState } from 'react';

import { getCommits } from '../../../core/render/monitor.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';
import { useRequestActions } from '../../contexts.js';
import { useElementWidth } from '../../hooks/useElementWidth.js';
import { useNow } from '../../hooks/useNow.js';
import { useRenderMonitoring } from '../../hooks/useRenderMonitoring.js';
import { color } from '../../theme.js';
import { TimelineChart } from './TimelineChart.js';
import { TimelineLegend } from './TimelineLegend.js';
import { TimelineTooltip } from './TimelineTooltip.js';
import { layoutTimeline, type BarLayout } from './timelineLayout.js';

const TICK_MS = 500;
const DEFAULT_WIDTH = 456;
const MIN_WIDTH = 240;

/** 네트워크 › 타임라인: 최근 20초의 요청과, 비교용으로 렌더 commit 을 함께 그린다. */
export const TimelineTab = ({ records }: { records: readonly RequestRecord[] }) => {
  useRenderMonitoring();
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState<BarLayout | null>(null);
  const { hover } = useRequestActions();
  const boxRef = useRef<HTMLDivElement>(null);
  const width = Math.max(MIN_WIDTH, useElementWidth(boxRef, DEFAULT_WIDTH));
  const now = useNow(TICK_MS, paused);
  const layout = layoutTimeline(records, getCommits(), now, width);
  const onHover = (bar: BarLayout | null) => {
    setHovered(bar);
    hover(bar?.record ?? null);
  };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: color.muted }}>
        <span>Network timeline · last 20s</span>
        <TimelineLegend />
        <span style={{ marginLeft: 'auto' }}>
          <Button active={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ Resume' : '❚❚ Pause'}
          </Button>
        </span>
      </div>
      <div ref={boxRef} style={{ position: 'relative' }}>
        <TimelineChart layout={layout} hovered={hovered?.record ?? null} onHover={onHover} />
        {hovered && <TimelineTooltip record={hovered.record} x={hovered.x} y={hovered.y + layout.laneH + 4} maxX={width} />}
      </div>
      <Muted>
        Hover a bar to see request info; click for details (headers, Request/Response Body). If render ticks appear right after a burst,
        each request triggers a separate render.
      </Muted>
    </div>
  );
};
