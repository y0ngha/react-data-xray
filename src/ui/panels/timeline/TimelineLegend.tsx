import { layoutShiftSupported } from '../../../core/render/layoutShifts.js';
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

const SHIFT_ITEM = {
  color: color.shift,
  mark: '▮',
  label: 'layout shift',
  title: 'Layout shifts (height = shift score). Hover for the component that moved and the response that caused it',
};

// 이동 표시는 layout-shift 를 주는 브라우저(Chromium 계열)에서만 나온다.
const itemsNow = () => (layoutShiftSupported() ? [...ITEMS, SHIFT_ITEM] : ITEMS);

export const TimelineLegend = () => (
  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0 6px' }}>
    {itemsNow().map((item) => (
      <span key={item.label} title={item.title} style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: item.color }}>{item.mark}</span> {item.label}
      </span>
    ))}
  </span>
);
