import { forwardRef, type CSSProperties, type ReactNode } from 'react';

interface FixedRectProps {
  rect: DOMRect;
  style: CSSProperties;
  children?: ReactNode;
  'data-color'?: string;
}

/** 화면 좌표의 사각형 위에 겹쳐 그리는 상자(오버레이 공통) */
export const FixedRect = forwardRef<HTMLDivElement, FixedRectProps>(function FixedRect({ rect, style, children, ...data }, ref) {
  return (
    <div
      ref={ref}
      {...data}
      style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: 'none', ...style }}
    >
      {children}
    </div>
  );
});
