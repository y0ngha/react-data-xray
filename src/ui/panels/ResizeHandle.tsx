import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { clamp } from '../../shared/format.js';

const MIN_SIZE = 160;
// 패널을 키워도 페이지가 이만큼은 보이게 둔다.
const PAGE_MARGIN = 80;

type ResizeEdge = 'top' | 'left';

/** 화면 가장자리에서 포인터까지의 거리 = 도킹한 패널의 새 크기 */
export const sizeFromPointer = (
  edge: ResizeEdge,
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): number => {
  const total = edge === 'top' ? viewport.height : viewport.width;
  const size = edge === 'top' ? viewport.height - clientY : viewport.width - clientX;
  return clamp(size, MIN_SIZE, total - PAGE_MARGIN);
};

/** 포인터를 뗄 때까지 움직임을 따라 크기를 알리고, 뗄 때 끝났음을 알린다. */
const trackResize = (edge: ResizeEdge, onResize: (size: number) => void, onResizeEnd: () => void): void => {
  const move = (ev: PointerEvent) =>
    onResize(sizeFromPointer(edge, ev.clientX, ev.clientY, { width: window.innerWidth, height: window.innerHeight }));
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onResizeEnd();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
};

const EDGE_STYLE: Record<ResizeEdge, CSSProperties> = {
  top: { left: 0, right: 0, top: -3, height: 6, cursor: 'ns-resize' },
  left: { top: 0, bottom: 0, left: -3, width: 6, cursor: 'ew-resize' },
};

interface ResizeHandleProps {
  edge: ResizeEdge;
  /** 끄는 동안 계속 부른다. */
  onResize: (size: number) => void;
  /** 손을 뗄 때 한 번 부른다(저장 등). */
  onResizeEnd: () => void;
}

/** 도킹한 패널의 안쪽 가장자리를 끌어 높이(하단) 또는 너비(오른쪽)를 바꾼다. */
export const ResizeHandle = ({ edge, onResize, onResizeEnd }: ResizeHandleProps) => (
  <hr
    aria-orientation={edge === 'top' ? 'horizontal' : 'vertical'}
    title="Drag to resize"
    onPointerDown={(e: ReactPointerEvent) => {
      e.preventDefault();
      trackResize(edge, onResize, onResizeEnd);
    }}
    style={{ position: 'absolute', margin: 0, border: 0, background: 'transparent', ...EDGE_STYLE[edge] }}
  />
);
