export type Tab = 'inspect' | 'requests' | 'timeline' | 'renders';

/** 네트워크와 렌더는 따로 보는 영역이라, 탭을 영역별로 묶어 어느 쪽을 보고 있는지 헷갈리지 않게 한다. */
export const TAB_GROUPS: ReadonlyArray<{ label: string; tabs: ReadonlyArray<{ tab: Tab; label: string; title: string }> }> = [
  { label: 'Data', tabs: [{ tab: 'inspect', label: 'Source', title: 'Click an element to see which API response its data comes from' }] },
  {
    label: 'Network',
    tabs: [
      { tab: 'requests', label: 'Requests', title: 'Request list and per-endpoint waste metrics' },
      { tab: 'timeline', label: 'Timeline', title: 'Network requests on a time axis, with render commits for comparison' },
    ],
  },
  { label: 'Renders', tabs: [{ tab: 'renders', label: 'Analysis', title: 'Render count, reasons, and avoidable renders' }] },
];
