import { Button } from '../components/Button.js';
import type { Dock } from '../hooks/useDockSettings.js';

const DOCK_OPTIONS: ReadonlyArray<{ dock: Dock; icon: string; title: string }> = [
  { dock: 'float', icon: '▭', title: 'Small (next to button)' },
  { dock: 'bottom', icon: '⬓', title: 'Dock bottom (wide)' },
  { dock: 'right', icon: '◨', title: 'Dock right' },
  { dock: 'window', icon: '⧉', title: 'Undock (new window)' },
];

/** Chrome DevTools 의 도킹 메뉴처럼 표시 방식을 고른다. */
export const DockPicker = ({ dock, onChange }: { dock: Dock; onChange: (dock: Dock) => void }) => (
  <span title="Display mode" style={{ display: 'inline-flex', gap: 2 }}>
    {DOCK_OPTIONS.map((o) => (
      <Button key={o.dock} active={dock === o.dock} onClick={() => onChange(o.dock)} title={o.title}>
        {o.icon}
      </Button>
    ))}
  </span>
);
