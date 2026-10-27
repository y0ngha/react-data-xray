import type { ReactNode } from 'react';

import { mutedStyle } from '../theme.js';

/** 보조 설명 글자 */
export const Muted = ({ children }: { children: ReactNode }) => <div style={mutedStyle}>{children}</div>;
