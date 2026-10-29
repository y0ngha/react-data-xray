import type { CSSProperties, ReactNode } from 'react';

import type { DockSettings } from '../hooks/useDockSettings.js';
import type { Position } from '../hooks/useDraggable.js';
import { Button } from '../components/Button.js';
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
  /** 앱 모달이 열려 도구 막대만 남기고 접었다. 펼치면 onExpand */
  collapsed?: boolean;
  onExpand?: () => void;
}

// 접었을 때: 도킹 크기를 풀어 도구 막대 높이만 차지한다. 오른쪽 도킹(위아래로 꽉 참)은 아래쪽을 푼다.
const collapsedPlacement = (placement: CSSProperties): CSSProperties => ({
  ...placement,
  height: 'auto',
  ...(placement.top === 0 && placement.bottom === 0 ? { bottom: 'auto' } : {}),
});

const noop = () => undefined;

const noticeStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  color: color.muted,
  borderTop: `1px solid ${color.border}`,
};

/** 패널 틀: 도킹 방식에 맞는 위치, 도킹했을 때의 크기 조절 손잡이, 도구 막대, 내용 */
export const Panel = ({ settings, buttonPosition, onResize, onResizeEnd, toolbar, children, collapsed = false, onExpand }: PanelProps) => {
  const placement = panelPlacement(settings, buttonPosition, { width: window.innerWidth, height: window.innerHeight });
  return (
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
        ...(collapsed ? collapsedPlacement(placement) : placement),
      }}
    >
      {settings.dock === 'bottom' && !collapsed && (
        <ResizeHandle edge="top" onResize={(bottomHeight) => onResize({ bottomHeight })} onResizeEnd={onResizeEnd} />
      )}
      {settings.dock === 'right' && !collapsed && (
        <ResizeHandle edge="left" onResize={(rightWidth) => onResize({ rightWidth })} onResizeEnd={onResizeEnd} />
      )}
      {toolbar}
      {collapsed ? (
        <div style={noticeStyle}>
          <span>An app dialog is open; panel collapsed to stay out of the way.</span>
          <Button onClick={onExpand ?? noop} subtle>
            Expand
          </Button>
        </div>
      ) : (
        <div style={{ padding: 8, overflow: 'auto', flex: 1 }}>{children}</div>
      )}
    </aside>
  );
};
