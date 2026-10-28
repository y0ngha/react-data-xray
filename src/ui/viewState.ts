import { useEffect, useSyncExternalStore } from 'react';

import { TAB_GROUPS, type Tab } from './panels/tabs.js';

// 앱 코드(API 모듈 등)를 고치거나 새로고침하면 페이지가 통째로 다시 열린다. 그때마다 패널이 닫히고 화면 박스가
// 꺼지지 않게, 탭을 닫을 때까지(sessionStorage) 기억한다. 새 탭은 처음 상태로 시작한다.
export const OPEN_KEY = 'react-data-xray:open';
/** 화면 박스 표시 토글 */
export const BOXES_KEY = 'react-data-xray:boxes';
export const TAB_KEY = 'react-data-xray:tab';

const TABS: readonly Tab[] = TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t.tab));

export const parseBool = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined);
export const parseTab = (raw: unknown): Tab | undefined => TABS.find((t) => t === raw);

/** 기억한 화면 상태를 지운다. rdx 가 오류로 멈췄을 때, 새로고침하면 같은 화면이 다시 열려 또 깨지지 않게 한다. */
export const resetViewState = (): void => {
  try {
    [OPEN_KEY, BOXES_KEY, TAB_KEY].forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // 저장소를 못 쓰면 넘어간다.
  }
};

// 배지 내역에서 고른 항목(엔드포인트·컴포넌트 이름). 그 탭이 아직 그려지지 않았어도 탭이 뜨면 받도록 모듈에 둔다.
type FocusTab = 'requests' | 'renders';
export interface FocusRequest {
  tab: FocusTab;
  key: string;
}
let request: FocusRequest | null = null;
// 탭이 닫히면 그 요청은 받은 것으로 친다(다시 열었을 때 지난 항목으로 가지 않게).
const taken = new WeakSet<FocusRequest>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** 그 탭이 key 의 항목으로 가게 한다(탭 쪽은 useFocusedItem 으로 받는다). */
export const focusItem = (tab: FocusTab, key: string): void => {
  request = { tab, key };
  listeners.forEach((l) => l());
};

/** 이 탭으로 온 항목. 고를 때마다 새 객체라 같은 항목을 다시 골라도 바뀐 것으로 읽히고, 탭이 닫히면 비워진다. */
export const useFocusedItem = (tab: FocusTab): FocusRequest | undefined => {
  const current = useSyncExternalStore(subscribe, () => request);
  const mine = current?.tab === tab && !taken.has(current) ? current : undefined;
  useEffect(
    () => () => {
      if (mine) taken.add(mine);
    },
    [mine],
  );
  return mine;
};
