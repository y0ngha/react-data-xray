import { Button } from '../components/Button.js';
import type { Dock } from '../hooks/useDockSettings.js';

const DOCK_OPTIONS: ReadonlyArray<{ dock: Dock; icon: string; title: string }> = [
  { dock: 'float', icon: '▭', title: '작게 보기 (버튼 옆)' },
  { dock: 'bottom', icon: '⬓', title: '하단에 도킹 (넓게 보기)' },
  { dock: 'right', icon: '◨', title: '오른쪽에 도킹' },
  { dock: 'window', icon: '⧉', title: '도킹 해제 (별도 창)' },
];

/** Chrome DevTools 의 도킹 메뉴처럼 표시 방식을 고른다. */
export const DockPicker = ({ dock, onChange }: { dock: Dock; onChange: (dock: Dock) => void }) => (
  <span title="표시 방식" style={{ display: 'inline-flex', gap: 2 }}>
    {DOCK_OPTIONS.map((o) => (
      <Button key={o.dock} active={dock === o.dock} onClick={() => onChange(o.dock)} title={o.title}>
        {o.icon}
      </Button>
    ))}
  </span>
);
