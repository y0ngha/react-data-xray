import { useRef, type PointerEvent } from 'react';

import { clamp } from '../../shared/format.js';
import { useStoredState } from './useStoredState.js';

const POSITION_KEY = 'react-data-xray:button';
// 이보다 적게 움직이면 클릭으로 본다.
const DRAG_THRESHOLD = 3;

export interface Position {
  x: number;
  y: number;
}

const parse = (raw: unknown): Position | undefined => {
  const p = raw as Partial<Position> | null;
  return typeof p?.x === 'number' && typeof p?.y === 'number' ? { x: p.x, y: p.y } : undefined;
};

interface Drag {
  dx: number;
  dy: number;
  start: Position;
  moved: boolean;
}

/**
 * 끌어서 옮길 수 있는 요소. 위치를 기억한다.
 * onClick 은 끌지 않고 눌렀다 뗐을 때만 부른다.
 */
export const useDraggable = (size: number, onClick: () => void) => {
  const [position, setPosition] = useStoredState(POSITION_KEY, parse, () => ({
    x: window.innerWidth - size - 20,
    y: window.innerHeight - size - 20,
  }));
  const drag = useRef<Drag | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { dx: e.clientX - position.x, dy: e.clientY - position.y, start: position, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = { x: clamp(e.clientX - d.dx, 0, window.innerWidth - size), y: clamp(e.clientY - d.dy, 0, window.innerHeight - size) };
    d.moved ||= Math.abs(next.x - d.start.x) + Math.abs(next.y - d.start.y) > DRAG_THRESHOLD;
    if (d.moved) setPosition(next);
  };

  const onPointerUp = () => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) onClick();
  };

  return { position, handlers: { onPointerDown, onPointerMove, onPointerUp } };
};
