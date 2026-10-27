import { color } from '../../theme.js';

const ITEMS: ReadonlyArray<{ color: string; mark: string; label: string }> = [
  { color: color.accent, mark: '■', label: '요청' },
  { color: color.warn, mark: '■', label: '낭비' },
  { color: color.review, mark: '■', label: '확인 필요(주기·포커스)' },
  { color: color.muted, mark: '■', label: '정상 반복' },
  { color: color.failed, mark: '■', label: '실패' },
  { color: color.render, mark: '▮', label: '비교용 렌더 commit(높이 = 렌더된 컴포넌트 수, 자세히는 렌더 › 분석)' },
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
