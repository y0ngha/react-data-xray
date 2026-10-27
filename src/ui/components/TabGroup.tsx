import type { ReactNode } from 'react';

import { color } from '../theme.js';

/** 탭을 영역(데이터·네트워크·렌더)별로 묶어 앞에 영역 이름을 붙인다. */
export const TabGroup = ({ label, children }: { label: string; children: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '0 4px', borderLeft: `1px solid ${color.border}` }}>
    <span style={{ color: color.muted, fontSize: 10, marginRight: 2 }}>{label}</span>
    {children}
  </span>
);
