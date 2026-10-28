import { useEffect, useState } from 'react';

import { isOwnUi } from '../ownUi.js';
import { dockAvoiding } from '../panels/panelLayout.js';
import type { DockSettings } from './useDockSettings.js';

// 앱의 모달. aria-modal 대화상자와 showModal() 로 연 <dialog>
const APP_MODAL = '[aria-modal="true"], dialog[open]';

/** 지금 화면에 보이는 앱 모달의 사각형. rdx 자신의 것과, 닫혀 숨겨진(display:none) 것은 뺀다. */
export const appModalRect = (): DOMRect | null => {
  const modal = Array.from(document.querySelectorAll(APP_MODAL)).find((el) => !isOwnUi(el) && el.getClientRects().length > 0);
  return modal ? modal.getBoundingClientRect() : null;
};

const sameRect = (a: DOMRect | null, b: DOMRect | null): boolean =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);

const touchesApp = (records: MutationRecord[]): boolean =>
  records.some((r) => {
    const el = r.target instanceof Element ? r.target : r.target.parentElement;
    return !isOwnUi(el);
  });

/** 모달이 생기거나 열리고 닫히는 변경만 본다(속성은 open·aria-modal 만). 한 프레임에 한 번만 다시 확인한다. */
const watchAppModal = (onChange: (rect: DOMRect | null) => void): (() => void) => {
  let frame = 0;
  const check = () => {
    frame = 0;
    onChange(appModalRect());
  };
  const observer = new MutationObserver((records) => {
    if (!frame && touchesApp(records)) frame = requestAnimationFrame(check);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
  // 감시를 시작할 때 이미 열려 있는 모달도 본다.
  frame = requestAnimationFrame(check);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
};

/**
 * 열려 있는 앱 모달의 사각형(없으면 null). 도킹한 패널은 화면 가장자리를 덮어, 그 자리에 있는 모달의 버튼을 가린다.
 * enabled 가 아니면(패널이 닫혔거나 별도 창) 감시하지 않는다.
 */
export const useAppModalRect = (enabled: boolean): DOMRect | null => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  // 같은 자리면 새 객체로 바꾸지 않아, 앱이 바뀔 때마다 rdx 가 다시 그려지지 않는다.
  useEffect(() => (enabled ? watchAppModal((next) => setRect((prev) => (sameRect(prev, next) ? prev : next))) : undefined), [enabled]);
  return enabled ? rect : null;
};

/**
 * 앱 모달이 열리면 패널이 가리지 않게 한다. 사용자가 도킹을 직접 고르지 않았으면 겹치지 않는 도킹으로 옮기고(settings),
 * 옮길 곳이 없거나 사용자가 고른 도킹이면 접는다. 펼치면(expand) 그 모달이 닫힐 때까지 펼쳐 두고, 다음 모달에서 다시 접는다.
 */
export const useCollapseForAppModal = (
  panelOpen: boolean,
  settings: DockSettings,
): { collapsed: boolean; expand: () => void; settings: DockSettings } => {
  // 별도 창은 앱 화면을 덮지 않는다.
  const modal = useAppModalRect(panelOpen && settings.dock !== 'window');
  const [keepExpanded, setKeepExpanded] = useState(false);
  if (!modal && keepExpanded) setKeepExpanded(false);
  const avoid = modal && !settings.chosen ? dockAvoiding(modal, new DOMRect(0, 0, window.innerWidth, window.innerHeight)) : null;
  return {
    collapsed: !!modal && !keepExpanded && (!avoid || avoid === 'float'),
    expand: () => setKeepExpanded(true),
    settings: avoid && avoid !== 'float' ? { ...settings, dock: avoid } : settings,
  };
};
