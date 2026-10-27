import type { ReactNode } from 'react';

import type { DockSettings } from '../hooks/useDockSettings.js';
import type { Position } from '../hooks/useDraggable.js';
import { ownUiProps } from '../ownUi.js';
import { color, FONT, Z_PANEL } from '../theme.js';
import { panelPlacement } from './panelLayout.js';
import { ResizeHandle } from './ResizeHandle.js';

interface PanelProps {
  settings: DockSettings;
  buttonPosition: Position;
  /** 끄는 동안 크기를 바꾼다(저장은 미룬다). */
  onResize: (patch: Partial<DockSettings>) => void;
  /** 다 끌었을 때 저장한다. */
  onResizeEnd: () => void;
  toolbar: ReactNode;
  children: ReactNode;
}

/** 패널 틀: 도킹 방식에 맞는 위치, 도킹했을 때의 크기 조절 손잡이, 도구 막대, 내용 */
export const Panel = ({ settings, buttonPosition, onResize, onResizeEnd, toolbar, children }: PanelProps) => (
  <aside
    aria-label="React Data X-ray"
    {...ownUiProps}
    style={{
      position: 'fixed',
      display: 'flex',
      flexDirection: 'column',
      zIndex: Z_PANEL,
      background: color.bg,
      color: color.text,
      font: FONT,
      wordBreak: 'break-all',
      ...panelPlacement(settings, buttonPosition, { width: window.innerWidth, height: window.innerHeight }),
    }}
  >
    {settings.dock === 'bottom' && (
      <ResizeHandle edge="top" onResize={(bottomHeight) => onResize({ bottomHeight })} onResizeEnd={onResizeEnd} />
    )}
    {settings.dock === 'right' && (
      <ResizeHandle edge="left" onResize={(rightWidth) => onResize({ rightWidth })} onResizeEnd={onResizeEnd} />
    )}
    {toolbar}
    <div style={{ padding: 8, overflow: 'auto', flex: 1 }}>{children}</div>
  </aside>
);
