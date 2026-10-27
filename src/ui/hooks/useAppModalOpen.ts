import { useEffect, useState } from 'react';

import { isOwnUi } from '../ownUi.js';

// 앱의 모달. aria-modal 대화상자와 showModal() 로 연 <dialog>
const APP_MODAL = '[aria-modal="true"], dialog[open]';

/** 지금 화면에 보이는 앱 모달이 있는지. rdx 자신의 것과, 닫혀 숨겨진(display:none) 것은 뺀다. */
export const hasAppModal = (): boolean =>
  Array.from(document.querySelectorAll(APP_MODAL)).some((el) => !isOwnUi(el) && el.getClientRects().length > 0);

const touchesApp = (records: MutationRecord[]): boolean =>
  records.some((r) => {
    const el = r.target instanceof Element ? r.target : r.target.parentElement;
    return !isOwnUi(el);
  });

/** 모달이 생기거나 열리고 닫히는 변경만 본다(속성은 open·aria-modal 만). 한 프레임에 한 번만 다시 확인한다. */
const watchAppModal = (onChange: (open: boolean) => void): (() => void) => {
  let frame = 0;
  const check = () => {
    frame = 0;
    onChange(hasAppModal());
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
 * 앱 모달이 열려 있는지. 도킹한 패널은 화면 가장자리를 덮어, 그 자리에 있는 모달의 버튼(닫기 등)을 가린다.
 * enabled 가 아니면(패널이 닫혔거나 별도 창) 감시하지 않는다.
 */
export const useAppModalOpen = (enabled: boolean): boolean => {
  const [open, setOpen] = useState(false);
  useEffect(() => (enabled ? watchAppModal(setOpen) : undefined), [enabled]);
  return enabled && open;
};

/** 앱 모달이 열리면 패널을 접는다. 펼치면(expand) 그 모달이 닫힐 때까지 펼쳐 두고, 다음 모달에서 다시 접는다. */
export const useCollapseForAppModal = (panelOpen: boolean, dock: string): { collapsed: boolean; expand: () => void } => {
  // 별도 창은 앱 화면을 덮지 않는다.
  const appModalOpen = useAppModalOpen(panelOpen && dock !== 'window');
  const [keepExpanded, setKeepExpanded] = useState(false);
  if (!appModalOpen && keepExpanded) setKeepExpanded(false);
  return { collapsed: appModalOpen && !keepExpanded, expand: () => setKeepExpanded(true) };
};
