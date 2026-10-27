import { TAB_GROUPS, type Tab } from './panels/tabs.js';

// 앱 코드(API 모듈 등)를 고치거나 새로고침하면 페이지가 통째로 다시 열린다. 그때마다 패널이 닫히고 전체 표시가
// 꺼지지 않게, 탭을 닫을 때까지(sessionStorage) 기억한다. 새 탭은 처음 상태로 시작한다.
export const OPEN_KEY = 'react-data-xray:open';
export const SHOW_ALL_KEY = 'react-data-xray:show-all';
export const TAB_KEY = 'react-data-xray:tab';

const TABS: readonly Tab[] = TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t.tab));

export const parseBool = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined);
export const parseTab = (raw: unknown): Tab | undefined => TABS.find((t) => t === raw);

/** 기억한 화면 상태를 지운다. rdx 가 오류로 멈췄을 때, 새로고침하면 같은 화면이 다시 열려 또 깨지지 않게 한다. */
export const resetViewState = (): void => {
  try {
    [OPEN_KEY, SHOW_ALL_KEY, TAB_KEY].forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // 저장소를 못 쓰면 넘어간다.
  }
};
