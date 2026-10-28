import { useEffect, useState } from 'react';

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
let pending: { tab: FocusTab; key: string } | null = null;
const listeners = new Set<() => void>();

/** 그 탭이 key 의 항목으로 가게 한다(탭 쪽은 useFocusedItem 으로 받는다). */
export const focusItem = (tab: FocusTab, key: string): void => {
  pending = { tab, key };
  listeners.forEach((l) => l());
};

/** 이 탭으로 온 항목 key. 한 번만 돌려주고(읽으면 비운다) 같은 항목을 다시 골라도 다시 돌려준다. */
export const useFocusedItem = (tab: FocusTab): string | undefined => {
  const [key, setKey] = useState<string>();
  useEffect(() => {
    const take = () => {
      if (pending?.tab !== tab) return;
      setKey(pending.key);
      pending = null;
    };
    take();
    listeners.add(take);
    return () => void listeners.delete(take);
  }, [tab]);
  // 값을 한 렌더 동안만 보인 뒤 비워, 같은 항목을 또 골라도 바뀐 것으로 읽힌다.
  useEffect(() => {
    if (key !== undefined) setKey(undefined);
  }, [key]);
  return key;
};
