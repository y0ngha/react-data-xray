import { useCallback } from 'react';

import { OPEN_KEY, parseBool } from '../viewState.js';
import { useDockSettings, type Dock } from './useDockSettings.js';
import { usePopupWindow } from './usePopupWindow.js';
import { useStoredState } from './useStoredState.js';

const no = () => false;

/**
 * 패널 열림(탭 단위로 기억)과 도킹. 별도 창 모드는 사용자의 동작(클릭·단축키) 안에서 창을 연다.
 * 별도 창은 사용자의 클릭 없이 열 수 없으므로, 다시 열린 페이지에서는 창이 생길 때까지 닫힌 것으로 본다.
 */
export const usePanelVisibility = () => {
  const [storedOpen, setOpen] = useStoredState(OPEN_KEY, parseBool, no, { area: 'session' });
  const { settings, update: updateDock, save: saveDock } = useDockSettings();
  // 별도 창이 막히거나 닫히면 작게 보기로 돌아온다.
  const { open: openPopup, close: closePopup, popup } = usePopupWindow(useCallback(() => updateDock({ dock: 'float' }), [updateDock]));
  const open = storedOpen && (settings.dock !== 'window' || popup !== null);

  const show = useCallback(() => {
    setOpen(true);
    if (settings.dock === 'window' && !popup) openPopup();
  }, [settings.dock, popup, openPopup, setOpen]);
  const hide = useCallback(() => {
    setOpen(false);
    closePopup();
  }, [closePopup, setOpen]);
  const changeDock = useCallback(
    (dock: Dock) => {
      updateDock({ dock, chosen: true });
      if (dock === 'window') openPopup();
      else closePopup();
    },
    [updateDock, openPopup, closePopup],
  );

  return { open, show, hide, popup, settings, updateDock, saveDock, changeDock };
};
