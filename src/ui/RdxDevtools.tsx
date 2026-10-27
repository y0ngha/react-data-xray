import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { inspect } from '../core/inspect/inspect.js';
import type { InspectResult } from '../core/inspect/types.js';
import type { RequestRecord } from '../core/requests/types.js';
import { RequestActionsProvider, type Focus, type RequestActions } from './contexts.js';
import { BUTTON_SIZE, FloatingButton } from './FloatingButton.js';
import { useDockSettings } from './hooks/useDockSettings.js';
import { useDraggable } from './hooks/useDraggable.js';
import { useElementPicker } from './hooks/useElementPicker.js';
import { useHotkey, type Hotkey } from './hooks/useHotkey.js';
import { useIgnoredEndpoints } from './hooks/useIgnoredEndpoints.js';
import { useStoredState } from './hooks/useStoredState.js';
import { OPEN_KEY, parseBool, parseTab, SHOW_ALL_KEY, TAB_KEY } from './viewState.js';
import { usePopupWindow } from './hooks/usePopupWindow.js';
import { useRequestAnalysis } from './hooks/useRequestAnalysis.js';
import { ConsumerHighlight } from './overlays/ConsumerHighlight.js';
import { PickHighlight } from './overlays/PickHighlight.js';
import { SourceOverlay } from './overlays/SourceOverlay.js';
import { ownUiProps } from './ownUi.js';
import { Panel } from './panels/Panel.js';
import { PanelContent } from './panels/PanelContent.js';
import { PanelToolbar } from './panels/PanelToolbar.js';
import type { Tab } from './panels/tabs.js';

export interface RdxDevtoolsProps {
  /** 요소 선택 단축키. 기본값 Ctrl+Shift+D (macOS 는 Cmd 도 허용) */
  hotkey?: Hotkey;
}

const DEFAULT_HOTKEY: Hotkey = { key: 'd', shift: true };

const no = () => false;
const firstTab = (): Tab => 'inspect';
const SESSION = { area: 'session' } as const;

/** rdx 의 조립 지점: 상태를 모아 패널·오버레이·버튼에 나눠 준다. */
export const RdxDevtools = ({ hotkey = DEFAULT_HOTKEY }: RdxDevtoolsProps) => {
  const [storedOpen, setOpen] = useStoredState(OPEN_KEY, parseBool, no, SESSION);
  const [tab, setTab] = useStoredState(TAB_KEY, parseTab, firstTab, SESSION);
  const [picking, setPicking] = useState(false);
  const [showAll, setShowAll] = useStoredState(SHOW_ALL_KEY, parseBool, no, SESSION);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [selected, setSelected] = useState<{ record: RequestRecord; focus?: Focus } | null>(null);
  const [hovered, setHovered] = useState<RequestRecord | null>(null);

  const { ignored, toggle: toggleIgnore } = useIgnoredEndpoints();
  const analysis = useRequestAnalysis(ignored);
  const { settings, update: updateDock, save: saveDock } = useDockSettings();
  // 별도 창이 막히거나 닫히면 작게 보기로 돌아온다.
  const popupWindow = usePopupWindow(useCallback(() => updateDock({ dock: 'float' }), [updateDock]));
  const { open: openPopup, close: closePopup, popup } = popupWindow;
  // 별도 창은 사용자의 클릭 없이 열 수 없으므로, 다시 열린 페이지에서는 창이 생길 때까지 닫힌 것으로 본다.
  const open = storedOpen && (settings.dock !== 'window' || popup !== null);

  /** 패널을 연다. 별도 창 모드면 사용자의 동작(클릭·단축키) 안에서 창을 연다. */
  const show = useCallback(() => {
    setOpen(true);
    if (settings.dock === 'window' && !popup) openPopup();
  }, [settings.dock, popup, openPopup, setOpen]);
  const hide = useCallback(() => {
    setOpen(false);
    closePopup();
  }, [closePopup, setOpen]);
  const { position, handlers } = useDraggable(BUTTON_SIZE, open ? hide : show);

  const startPicking = useCallback(() => {
    show();
    setTab('inspect');
    setSelected(null);
    setPicking((v) => !v);
  }, [show, setTab]);
  const stopPicking = useCallback(() => setPicking(false), []);
  useHotkey(hotkey, startPicking, stopPicking);
  const pickRect = useElementPicker(
    picking,
    useCallback((el: Element) => {
      setResult(inspect(el));
      setPicking(false);
    }, []),
  );

  // 요청이 들어올 때마다 classOf 가 바뀌어도 open 은 그대로라야 오버레이 박스가 다시 렌더되지 않는다.
  const openRequest = useCallback<RequestActions['open']>(
    (record, focus) => {
      show();
      setSelected({ record, focus });
    },
    [show],
  );
  const actions = useMemo<RequestActions>(
    () => ({ open: openRequest, hover: setHovered, classOf: analysis.classOf }),
    [analysis.classOf, openRequest],
  );

  const panel = (
    <Panel
      settings={settings}
      buttonPosition={position}
      onResize={(patch) => updateDock(patch, { persist: false })}
      onResizeEnd={saveDock}
      toolbar={
        <PanelToolbar
          activeTab={selected ? null : tab}
          onTab={(next) => {
            setTab(next);
            setSelected(null);
          }}
          picking={picking}
          onTogglePicking={startPicking}
          pickTitle={
            settings.dock === 'window' ? '원래 창에서 요소를 클릭하세요' : `요소 선택 (Ctrl/Cmd+Shift+${hotkey.key.toUpperCase()})`
          }
          showAll={showAll}
          onToggleShowAll={() => setShowAll((v) => !v)}
          wasteCount={analysis.wasteCount}
          dock={settings.dock}
          onDock={(dock) => {
            updateDock({ dock });
            if (dock === 'window') openPopup();
            else closePopup();
          }}
          onClose={hide}
        />
      }
    >
      <PanelContent
        tab={tab}
        picking={picking}
        selected={selected}
        onBack={() => setSelected(null)}
        result={result}
        analysis={analysis}
        ignored={ignored}
        onToggleIgnore={toggleIgnore}
      />
    </Panel>
  );

  return createPortal(
    <RequestActionsProvider value={actions}>
      <div {...ownUiProps}>
        {showAll && <SourceOverlay />}
        {hovered && <ConsumerHighlight record={hovered} />}
        {pickRect && <PickHighlight rect={pickRect} />}
        {open && settings.dock !== 'window' && panel}
        {open && settings.dock === 'window' && popup && createPortal(panel, popup.document.body)}
        <FloatingButton position={position} warn={analysis.wasteCount > 0} handlers={handlers} />
      </div>
    </RequestActionsProvider>,
    document.body,
  );
};
