import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { unionRect } from '../../core/fiber/tree.js';
import type { Box } from '../../core/inspect/types.js';
import { getRenderInfo, subscribeCommits } from '../../core/render/monitor.js';
import { RENDER_STORM } from '../../core/render/types.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { isWaste } from '../../core/requests/classify.js';
import { pathOf, requestKeyOf } from '../../core/requests/requestKey.js';
import { getEndpointStats, statSummary, type EndpointStat } from '../../core/requests/endpointStats.js';
import type { RequestClass } from '../../core/requests/classify.js';
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

/** 글자가 같으면 쓰지 않는다. textContent 를 쓰면 같은 글자여도 텍스트 노드를 갈아 끼워 레이아웃을 다시 한다. */
const setText = (el: HTMLElement, text: string): void => {
  if (el.textContent !== text) el.textContent = text;
};

const paintMetrics = ({ box, metrics }: BoxElements, statOf: StatOf): void => {
  const text = statSummary(statOf(box.hit.record));
  setText(metrics, text ? ` req ${text}` : '');
};

/**
 * 겹친 박스의 라벨이 서로 붙으면 어느 박스 것인지 읽을 수 없다. 큰 박스부터 라벨 자리를 잡고,
 * 먼저 잡힌 라벨과 겹치거나 닿는 라벨은 그 아래로 내린다. 크기를 먼저 다 읽고 위치를 한꺼번에 쓴다(번갈아 하면 라벨마다 레이아웃을 다시 계산한다).
 */
const LABEL_GAP = 3;
/** 테스트에서 직접 부른다. */
export const separateLabels = (all: BoxElements[], rects: (DOMRect | null)[]): void => {
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const order = all.map((_, i) => i).filter((i) => rects[i]);
  order.sort((a, b) => rects[b]!.width * rects[b]!.height - rects[a]!.width * rects[a]!.height);
  const sizes = all.map(({ label }, i) => (rects[i] ? { width: label.offsetWidth, height: label.offsetHeight } : null));
  const tops: number[] = [];
  for (const i of order) {
    const rect = rects[i]!;
    const left = rect.left;
    const right = left + sizes[i]!.width;
    const height = sizes[i]!.height;
    let top = rect.top;
    // 아래로 내리면 새로 겹치는 라벨이 생길 수 있어 겹침이 없을 때까지 되풀이한다(라벨 수가 상한).
    for (let n = 0; n <= placed.length; n++) {
      const hit = placed.find(
        (p) => left < p.right + LABEL_GAP && p.left < right + LABEL_GAP && top < p.bottom + LABEL_GAP && p.top < top + height + LABEL_GAP,
      );
      if (!hit) break;
      top = hit.bottom + LABEL_GAP;
    }
    tops[i] = top - rect.top;
    placed.push({ left, right, top, bottom: top + height });
  }
  order.forEach((i) => (all[i].label.style.top = `${tops[i]}px`));
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
  setText(count, recent > 0 ? `renders: ${recent}${render!.avoidable > 0 ? ` · avoidable: ${render!.avoidable}` : ''}` : '');
  label.title = `Click to see request details. ×N = call count for this request, renders N = render count of components using this response${render ? `. Components using this response rendered ${render.recent} times in the last 10s; ${render.avoidable} were avoidable` : ''}`;
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
    // ref 는 effect 보다 먼저 붙으므로, 같은 렌더에서 바뀐 집계를 읽도록 다음 프레임에 칠한다.
    requestAnimationFrame(() => paintMetrics(els, latestStatOf.current));
  }, []);

  useEffect(() => {
    const pending = { position: false, renders: false, metrics: false };
    let frame = 0;
    let flashEnd = 0;
    const paint = () => {
      frame = 0;
      const now = Date.now();
      const all = Array.from(elements.current.values());
      // 읽기(위치) → 쓰기(위치·렌더·지표 글자) → 읽기(라벨 크기) → 쓰기(라벨 위치) 순으로 해서 강제 레이아웃을 한 번만 겪는다.
      const rects = all.map((els) => unionRect(els.box.nodes));
      if (pending.position) all.forEach((els, i) => placeBox(els.root, rects[i]));
      if (pending.renders) all.forEach((els) => paintRenders(els, now));
      if (pending.metrics) all.forEach((els) => paintMetrics(els, latestStatOf.current));
      // 렌더 수·지표 글자가 바뀌면 라벨 너비도 바뀐다.
      separateLabels(all, rects);
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
        title="Click to see request details"
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
        <b style={{ display: 'none', marginRight: 6 }} />
        {pathOf(box.hit.record.url)}
        <span data-metrics="" />
      </button>
    </FixedRect>
  );
});

/** 화면 박스: 분석 대상 안에서 데이터 출처가 있는 컴포넌트마다 박스, URL 과 그 API 의 지표, 렌더 횟수를 그리고 렌더될 때마다 깜빡인다. */
export const SourceOverlay = ({
  boxes,
  records,
  classes,
}: {
  boxes: readonly Box[];
  records: readonly RequestRecord[];
  classes: ReadonlyMap<number, RequestClass>;
}) => {
  // 박스 하나는 쿼리·본문까지 같은 요청 하나를 가리키므로, 지표도 같은 요청별로 센다(page=1 과 page=2 를 섞지 않게).
  const stats = useMemo(() => new Map(getEndpointStats(records, classes, requestKeyOf).map((s) => [s.endpoint, s])), [records, classes]);
  const statOf = useCallback((record: RequestRecord) => stats.get(requestKeyOf(record)), [stats]);
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
