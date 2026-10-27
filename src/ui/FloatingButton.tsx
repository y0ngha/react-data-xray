import type { PointerEvent } from 'react';

import type { Position } from './hooks/useDraggable.js';
import { color, Z_PANEL } from './theme.js';

export const BUTTON_SIZE = 44;

interface FloatingButtonProps {
  position: Position;
  /** 낭비 요청이 있으면 테두리를 빨갛게 */
  warn: boolean;
  handlers: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: () => void;
  };
}

/** 끌어서 옮길 수 있는 RDX 버튼(표시만 한다. 드래그·클릭 처리는 useDraggable) */
export const FloatingButton = ({ position, warn, handlers }: FloatingButtonProps) => (
  <button
    type="button"
    aria-label="React Data X-ray 열기"
    title="React Data X-ray (드래그로 이동)"
    {...handlers}
    style={{
      position: 'fixed',
      left: position.x,
      top: position.y,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: '50%',
      border: `2px solid ${warn ? color.warn : color.accent}`,
      background: color.bg,
      color: color.text,
      font: 'bold 13px ui-monospace, Menlo, monospace',
      cursor: 'grab',
      zIndex: Z_PANEL,
      boxShadow: '0 2px 12px rgba(0,0,0,.4)',
      touchAction: 'none',
    }}
  >
    RDX
  </button>
);
