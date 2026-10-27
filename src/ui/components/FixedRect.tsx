import type { CSSProperties, ReactNode } from 'react';

/** 화면 좌표의 사각형 위에 겹쳐 그리는 상자(오버레이 공통) */
export const FixedRect = ({ rect, style, children }: { rect: DOMRect; style: CSSProperties; children?: ReactNode }) => (
  <div
    style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: 'none', ...style }}
  >
    {children}
  </div>
);
