import { useRef, useSyncExternalStore, type MouseEvent, type PointerEvent } from 'react';

import { clamp } from '../../shared/format.js';
import { clientViewport } from '../viewport.js';
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

const subscribeResize = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
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
export const useDraggable = (size: number, onClickProp: () => void) => {
  const [stored, setPosition, savePosition] = useStoredState(POSITION_KEY, parse, () => {
    const vp = clientViewport();
    return { x: vp.width - size - 20, y: vp.height - size - 20 };
  });
  // 큰 창에서 옮겨 둔 위치를 작은 창에서 열면 화면 밖으로 나가므로, 지금 창 안으로 당겨서 그린다.
  const width = useSyncExternalStore(subscribeResize, () => clientViewport().width);
  const height = useSyncExternalStore(subscribeResize, () => clientViewport().height);
  const position = { x: clamp(stored.x, 0, Math.max(0, width - size)), y: clamp(stored.y, 0, Math.max(0, height - size)) };
  const drag = useRef<Drag | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { dx: e.clientX - position.x, dy: e.clientY - position.y, start: position, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const vp = clientViewport();
    const next = { x: clamp(e.clientX - d.dx, 0, vp.width - size), y: clamp(e.clientY - d.dy, 0, vp.height - size) };
    d.moved ||= Math.abs(next.x - d.start.x) + Math.abs(next.y - d.start.y) > DRAG_THRESHOLD;
    if (d.moved) setPosition(next, { persist: false });
  };

  const onPointerUp = () => {
    // 다른 곳에서 누르고(텍스트 선택 등) 버튼 위에서 뗀 것은 클릭이 아니다.
    if (!drag.current) return;
    const moved = drag.current.moved;
    drag.current = null;
    // 끄는 동안에는 저장을 미루고, 다 끌었을 때 한 번만 저장한다.
    if (moved) savePosition();
    else onClickProp();
  };

  // 키보드(Enter·Space)로 누르면 pointer 이벤트 없이 click 만 온다(detail 0). 마우스 클릭은 pointerup 에서 이미 처리했다.
  const onClick = (e: MouseEvent) => {
    if (e.detail === 0) onClickProp();
  };

  return { position, handlers: { onPointerDown, onPointerMove, onPointerUp, onClick } };
};
