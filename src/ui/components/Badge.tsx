import type { ReactNode } from 'react';

export const Badge = ({ color, children }: { color: string; children: ReactNode }) => (
  <span style={{ color, border: `1px solid ${color}`, borderRadius: 4, padding: '0 4px', marginRight: 4, fontSize: 11 }}>{children}</span>
);
