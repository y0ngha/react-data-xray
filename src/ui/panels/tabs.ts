export type Tab = 'inspect' | 'requests' | 'timeline' | 'renders';

/** 네트워크와 렌더는 따로 보는 영역이라, 탭을 영역별로 묶어 어느 쪽을 보고 있는지 헷갈리지 않게 한다. */
export const TAB_GROUPS: ReadonlyArray<{ label: string; tabs: ReadonlyArray<{ tab: Tab; label: string; title: string }> }> = [
  { label: '데이터', tabs: [{ tab: 'inspect', label: '출처', title: '요소를 클릭해 어느 API 응답의 데이터인지 봅니다' }] },
  {
    label: '네트워크',
    tabs: [
      { tab: 'requests', label: '요청', title: '네트워크 요청 목록과 엔드포인트별 낭비 지표' },
      { tab: 'timeline', label: '타임라인', title: '네트워크 요청을 시간축에 놓고, 비교용으로 렌더 commit 을 함께 보여 줍니다' },
    ],
  },
  { label: '렌더', tabs: [{ tab: 'renders', label: '분석', title: '렌더 횟수, 이유, 줄일 수 있는 렌더' }] },
];
