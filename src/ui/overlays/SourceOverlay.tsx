import { memo, useCallback, useEffect, useRef } from 'react';

import { unionRect } from '../../core/fiber/tree.js';
import type { Box } from '../../core/inspect/types.js';
import { getRenderInfo, subscribeCommits } from '../../core/render/monitor.js';
import { RENDER_STORM } from '../../core/render/types.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { isWaste } from '../../core/requests/classify.js';
import { endpointOf, pathOf } from '../../core/requests/requestKey.js';
import { statSummary, type EndpointStat } from '../../core/requests/endpointStats.js';
import { FixedRect } from '../components/FixedRect.js';
import { useRequestActions } from '../contexts.js';
import { color, MATCH_COLOR, SMALL_FONT, Z_OVERLAY } from '../theme.js';

// 렌더 직후 박스를 이만큼 보라색으로 강조한다(React DevTools 의 Highlight updates 처럼).
const FLASH_MS = 600;
// 렌더 횟수가 시간이 지나며 줄어드는 것과 commit 없이 바뀐 위치를 반영하는 주기
const TICK_MS = 1000;

interface BoxElements {
  box: Box;
  root: HTMLDivElement;
  label: HTMLButtonElement;
  count: HTMLElement;
  /** API 지표(×6 · 중복 2 · 같은 응답 3) */
  metrics: HTMLElement;
}

type StatOf = (record: RequestRecord) => EndpointStat | undefined;

const placeBox = (root: HTMLDivElement, rect: DOMRect | null): void => {
  root.style.display = rect ? '' : 'none';
  if (!rect) return;
  root.style.left = `${rect.left}px`;
  root.style.top = `${rect.top}px`;
  root.style.width = `${rect.width}px`;
  root.style.height = `${rect.height}px`;
};

const paintMetrics = ({ box, metrics }: BoxElements, statOf: StatOf): void => {
  const text = statSummary(statOf(box.hit.record));
  metrics.textContent = text ? ` ${text}` : '';
};

const paintRenders = ({ box, root, label, count }: BoxElements, now: number): void => {
  const render = getRenderInfo(box.fiber, now);
  const flashing = !!render && now - render.last < FLASH_MS;
  const base = root.dataset.color ?? '';
  root.style.outline = flashing ? `2px solid ${color.render}` : `1px solid ${base}`;
  root.style.background = flashing ? `${color.render}33` : `${base}14`;
  const recent = render?.recent ?? 0;
  count.style.display = recent > 0 ? '' : 'none';
  count.style.color = recent >= RENDER_STORM ? '#7f1d1d' : '#000';
  count.textContent = recent > 0 ? `↻${recent}${render!.avoidable > 0 ? `(불필요 ${render!.avoidable})` : ''}` : '';
  label.title = `클릭하면 요청 상세를 봅니다${render ? ` · 최근 10초 렌더 ${render.recent}회, 줄일 수 있는 렌더 ${render.avoidable}회` : ''}`;
};

/**
 * 박스 위치와 렌더 표시를 React 렌더 없이 DOM 에 직접 쓴다. 박스가 수백 개라 150ms 마다 React 로
 * 다시 그리면 메인 스레드를 다 쓴다. 스크롤은 위치만, commit 은 렌더 표시와 위치를 한 프레임에 한 번 고친다.
 */
const useBoxPainter = (statOf: StatOf) => {
  const elements = useRef(new Map<number, BoxElements>());
  // 요청이 들어올 때마다 박스를 React 로 다시 그리지 않도록, 지표는 최신 집계를 읽어 painter 가 쓴다.
  const latestStatOf = useRef(statOf);
  useEffect(() => {
    latestStatOf.current = statOf;
  }, [statOf]);
  const register = useCallback((box: Box, el: HTMLDivElement | null) => {
    const label = el?.querySelector('button');
    const count = el?.querySelector('b');
    const metrics = el?.querySelector<HTMLElement>('[data-metrics]');
    if (!el || !label || !count || !metrics) {
      elements.current.delete(box.id);
      return;
    }
    const els = { box, root: el, label, count, metrics };
    elements.current.set(box.id, els);
    paintRenders(els, Date.now());
    paintMetrics(els, latestStatOf.current);
  }, []);

  useEffect(() => {
    const pending = { position: false, renders: false, metrics: false };
    let frame = 0;
    let flashEnd = 0;
    const paint = () => {
      frame = 0;
      const now = Date.now();
      const all = Array.from(elements.current.values());
      if (pending.position) {
        // 위치를 모두 읽은 뒤에 쓴다. 읽고 쓰기를 번갈아 하면 박스마다 레이아웃을 다시 계산한다.
        const rects = all.map((els) => unionRect(els.box.nodes));
        all.forEach((els, i) => placeBox(els.root, rects[i]));
      }
      if (pending.renders) all.forEach((els) => paintRenders(els, now));
      if (pending.metrics) all.forEach((els) => paintMetrics(els, latestStatOf.current));
      Object.assign(pending, { position: false, renders: false, metrics: false });
    };
    const schedule = (kind: keyof typeof pending) => () => {
      pending[kind] = true;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const repaintPosition = schedule('position');
    const repaintRenders = schedule('renders');
    const repaintMetrics = schedule('metrics');
    const onCommit = () => {
      repaintRenders();
      // 깜빡임을 끄는 다시 그리기
      window.clearTimeout(flashEnd);
      flashEnd = window.setTimeout(repaintRenders, FLASH_MS);
      // 렌더로 레이아웃이 바뀌었을 수 있다.
      repaintPosition();
    };
    // 렌더 횟수는 시간이 지나며 줄고, 위치는 commit·스크롤 없이도 바뀐다(늦게 뜬 이미지, 애니메이션).
    const timer = window.setInterval(() => {
      repaintRenders();
      repaintPosition();
      repaintMetrics();
    }, TICK_MS);
    const unsubscribe = subscribeCommits(onCommit);
    window.addEventListener('scroll', repaintPosition, true);
    window.addEventListener('resize', repaintPosition);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(flashEnd);
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener('scroll', repaintPosition, true);
      window.removeEventListener('resize', repaintPosition);
    };
  }, []);

  return register;
};

interface SourceBoxProps {
  box: Box;
  waste: boolean;
  onOpen: (record: RequestRecord) => void;
  register: (box: Box, el: HTMLDivElement | null) => void;
}

/** 박스 하나. 처음 모양만 React 로 그리고, 위치·렌더 표시는 useBoxPainter 가 고친다. */
const SourceBox = memo(function SourceBox({ box, waste, onOpen, register }: SourceBoxProps) {
  // 같은 엔드포인트의 다른 호출이 아니라, 이 데이터를 준 요청 자체가 낭비였을 때만 빨갛게 그린다.
  const boxColor = waste ? color.warn : MATCH_COLOR[box.hit.match];
  const ref = useCallback((el: HTMLDivElement | null) => register(box, el), [box, register]);
  return (
    <FixedRect
      ref={ref}
      rect={box.rect}
      data-color={boxColor}
      style={{ outline: `1px solid ${boxColor}`, background: `${boxColor}14`, zIndex: Z_OVERLAY }}
    >
      <button
        type="button"
        title="클릭하면 요청 상세를 봅니다"
        onClick={() => onOpen(box.hit.record)}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          pointerEvents: 'auto',
          cursor: 'pointer',
          border: 0,
          background: boxColor,
          color: '#000',
          font: SMALL_FONT,
          padding: '0 3px',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
          overflow: 'hidden',
        }}
      >
        <b style={{ display: 'none', marginRight: 4 }} />
        {pathOf(box.hit.record.url)}
        <span data-metrics="" />
      </button>
    </FixedRect>
  );
});

/** 화면 박스: 분석 대상 안에서 데이터 출처가 있는 컴포넌트마다 박스, URL 과 그 API 의 지표, 렌더 횟수를 그리고 렌더될 때마다 깜빡인다. */
export const SourceOverlay = ({ boxes, stats }: { boxes: readonly Box[]; stats: ReadonlyMap<string, EndpointStat> }) => {
  const statOf = useCallback((record: RequestRecord) => stats.get(endpointOf(record)), [stats]);
  const register = useBoxPainter(statOf);
  const { open, classOf } = useRequestActions();
  return (
    <>
      {boxes.map((box) => (
        <SourceBox key={box.id} box={box} waste={isWaste(classOf(box.hit.record))} onOpen={open} register={register} />
      ))}
    </>
  );
};
