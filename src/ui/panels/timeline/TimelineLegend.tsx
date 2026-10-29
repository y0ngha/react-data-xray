import { color } from '../../theme.js';

const ITEMS: ReadonlyArray<{ color: string; mark: string; label: string; title?: string }> = [
  { color: color.accent, mark: '■', label: 'request' },
  { color: color.warn, mark: '■', label: 'waste' },
  { color: color.review, mark: '■', label: 'review (polling·focus)' },
  { color: color.muted, mark: '■', label: 'expected repeat' },
  { color: color.failed, mark: '■', label: 'failed' },
  {
    color: color.render,
    mark: '▮',
    label: 'render commit',
    // 긴 설명은 좁은 패널에서 넘치므로 툴팁으로 둔다.
    title: 'Render commits for comparison (height = number of components rendered; details in Renders › Analysis)',
  },
];

export const TimelineLegend = () => (
  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0 6px' }}>
    {ITEMS.map((item) => (
      <span key={item.label} title={item.title} style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: item.color }}>{item.mark}</span> {item.label}
      </span>
    ))}
  </span>
);
