import type { CSSProperties } from 'react';

import { clamp } from '../../shared/format.js';
import { DEFAULT_DOCK, type Dock, type DockSettings } from '../hooks/useDockSettings.js';
import type { Position } from '../hooks/useDraggable.js';
import { BUTTON_SIZE } from '../FloatingButton.js';
import { color } from '../theme.js';

const FLOAT_WIDTH = 480;
const GAP = 8;

/** 작게 보기: 버튼 위쪽(공간이 없으면 아래쪽)에, 화면 밖으로 나가지 않게 둔다. */
const floatPosition = (button: Position, viewport: { width: number; height: number }): CSSProperties => {
  const left = clamp(button.x + BUTTON_SIZE - FLOAT_WIDTH, 0, viewport.width - FLOAT_WIDTH);
  return button.y > viewport.height / 2 ? { left, bottom: viewport.height - button.y + GAP } : { left, top: button.y + BUTTON_SIZE + GAP };
};

/** 도킹 방식에 따른 패널 위치·크기 */
export const panelPlacement = (settings: DockSettings, button: Position, viewport: { width: number; height: number }): CSSProperties => {
  switch (settings.dock) {
    case 'bottom':
      return { left: 0, right: 0, bottom: 0, height: settings.bottomHeight, borderTop: `1px solid ${color.border}` };
    case 'right':
      return { top: 0, right: 0, bottom: 0, width: settings.rightWidth, borderLeft: `1px solid ${color.border}` };
    case 'window':
      return { position: 'static', width: '100%', height: '100vh' };
    default:
      return {
        ...floatPosition(button, viewport),
        width: FLOAT_WIDTH,
        maxHeight: '70vh',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,.4)',
      };
  }
};

/** 앱 모달과 겹치지 않는 도킹. 아래, 오른쪽 순으로 보고, 둘 다 겹치면 float(호출한 쪽이 접는다). 기본 크기 기준이다. */
export const dockAvoiding = (modal: DOMRect, viewport: DOMRect): Dock => {
  if (modal.bottom <= viewport.bottom - DEFAULT_DOCK.bottomHeight) return 'bottom';
  if (modal.right <= viewport.right - DEFAULT_DOCK.rightWidth) return 'right';
  return 'float';
};
