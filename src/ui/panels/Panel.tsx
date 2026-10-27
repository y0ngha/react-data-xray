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
  onResize: (patch: Partial<DockSettings>) => void;
  toolbar: ReactNode;
  children: ReactNode;
}

/** 패널 틀: 도킹 방식에 맞는 위치, 도킹했을 때의 크기 조절 손잡이, 도구 막대, 내용 */
export const Panel = ({ settings, buttonPosition, onResize, toolbar, children }: PanelProps) => (
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
    {settings.dock === 'bottom' && <ResizeHandle edge="top" onResize={(bottomHeight) => onResize({ bottomHeight })} />}
    {settings.dock === 'right' && <ResizeHandle edge="left" onResize={(rightWidth) => onResize({ rightWidth })} />}
    {toolbar}
    <div style={{ padding: 8, overflow: 'auto', flex: 1 }}>{children}</div>
  </aside>
);
