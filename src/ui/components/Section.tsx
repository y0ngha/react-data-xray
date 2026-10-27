import type { ReactNode } from 'react';

import { color } from '../theme.js';
import { CopyButton } from './CopyButton.js';

/** 펼치고 접을 수 있는 구역. copy 를 주면 제목 옆에 복사 버튼을 둔다. */
export const Section = ({ title, children, copy }: { title: string; children: ReactNode; copy?: string }) => (
  <details open style={{ marginTop: 6 }}>
    <summary style={{ cursor: 'pointer', color: color.heading }}>
      {title}
      {copy !== undefined && <CopyButton text={copy} />}
    </summary>
    {children}
  </details>
);
