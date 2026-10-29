import type { ReactNode } from 'react';

import { color } from '../theme.js';

interface ButtonProps {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
  /** 테두리만 있는 작은 버튼(행 안의 보조 동작) */
  subtle?: boolean;
}

export const Button = ({ children, onClick, active = false, title, subtle = false }: ButtonProps) => (
  <button
    type="button"
    title={title}
    aria-pressed={active}
    onClick={onClick}
    style={{
      background: active ? color.accent : 'transparent',
      color: subtle ? color.muted : color.text,
      border: `1px solid ${active ? color.accent : color.border}`,
      borderRadius: 4,
      padding: subtle ? '0 6px' : '2px 8px',
      cursor: 'pointer',
      font: 'inherit',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </button>
);
