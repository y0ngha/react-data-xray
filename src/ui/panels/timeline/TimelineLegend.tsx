import { color } from '../../theme.js';

const ITEMS: ReadonlyArray<{ color: string; mark: string; label: string }> = [
  { color: color.accent, mark: '■', label: 'request' },
  { color: color.warn, mark: '■', label: 'waste' },
  { color: color.review, mark: '■', label: 'review (polling·focus)' },
  { color: color.muted, mark: '■', label: 'expected repeat' },
  { color: color.failed, mark: '■', label: 'failed' },
  { color: color.render, mark: '▮', label: 'render commit for comparison (height = component count; see Renders › Analysis)' },
];

export const TimelineLegend = () => (
  <span>
    {ITEMS.map((item) => (
      <span key={item.label} style={{ marginRight: 6 }}>
        <span style={{ color: item.color }}>{item.mark}</span> {item.label}
      </span>
    ))}
  </span>
);
