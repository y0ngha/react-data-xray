import type { MouseEvent, PointerEvent } from 'react';

import type { Position } from './hooks/useDraggable.js';
import { color, Z_PANEL } from './theme.js';

export const BUTTON_SIZE = 44;

interface FloatingButtonProps {
  position: Position;
  /** 문제 수(낭비 요청이 있는 엔드포인트 + 렌더 폭주 컴포넌트). 0 보다 크면 테두리를 빨갛게 하고 숫자를 단다 */
  issues: number;
  /** 방금 요청이 몰렸거나 렌더 폭주가 생겼다. 애니메이션 없이 색만 잠깐 바꾼다(움직임을 줄이는 설정에도 부담 없게) */
  alert: boolean;
  handlers: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: () => void;
    onClick: (e: MouseEvent) => void;
  };
}

/** 끌어서 옮길 수 있는 RDX 버튼(표시만 한다. 드래그·클릭 처리는 useDraggable) */
const borderColor = (issues: number, alert: boolean): string => (alert ? color.render : issues > 0 ? color.warn : color.accent);

export const FloatingButton = ({ position, issues, alert, handlers }: FloatingButtonProps) => (
  <button
    type="button"
    aria-label={`React Data X-ray 열기${issues > 0 ? ` (문제 ${issues}개)` : ''}`}
    title={`React Data X-ray (드래그로 이동)${issues > 0 ? ` · 문제 ${issues}개` : ''}`}
    {...handlers}
    style={{
      position: 'fixed',
      left: position.x,
      top: position.y,
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: '50%',
      border: `2px solid ${borderColor(issues, alert)}`,
      background: color.bg,
      color: color.text,
      font: 'bold 13px ui-monospace, Menlo, monospace',
      cursor: 'grab',
      zIndex: Z_PANEL,
      boxShadow: alert ? `0 0 0 4px ${color.render}66` : '0 2px 12px rgba(0,0,0,.4)',
      touchAction: 'none',
    }}
  >
    RDX
    {issues > 0 && (
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: -6,
          right: -6,
          minWidth: 18,
          height: 18,
          padding: '0 4px',
          borderRadius: 9,
          background: color.warn,
          color: '#000',
          font: 'bold 11px/18px ui-monospace, Menlo, monospace',
        }}
      >
        {issues > 99 ? '99+' : issues}
      </span>
    )}
  </button>
);
