import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { RequestRecord } from '../core/requests/types.js';
import { RequestActionsProvider, type Focus, type RequestActions } from './contexts.js';
import { BUTTON_SIZE, FloatingButton } from './FloatingButton.js';
import { useDraggable } from './hooks/useDraggable.js';
import { useElementPicker } from './hooks/useElementPicker.js';
import { useHotkey, type Hotkey } from './hooks/useHotkey.js';
import { useIgnoredEndpoints } from './hooks/useIgnoredEndpoints.js';
import { useStoredState } from './hooks/useStoredState.js';
import { BOXES_KEY, parseBool, parseTab, TAB_KEY } from './viewState.js';
import { usePanelVisibility } from './hooks/usePanelVisibility.js';
import { useOverlayBoxes } from './hooks/useOverlayBoxes.js';
import { useRequestAnalysis } from './hooks/useRequestAnalysis.js';
import { useAnalysisScope, useScopedAnalysis } from './hooks/useAnalysisScope.js';
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

/** 박스는 화면에 그릴 때, 데이터 관점일 때, 범위로 요청을 거를 때만 모은다(트리 전체를 훑는 일이라). */
const needsBoxes = (visible: boolean, panelOpen: boolean, scoped: boolean, tab: Tab): boolean =>
  visible || (panelOpen && (scoped || tab === 'inspect'));

/** rdx 의 조립 지점: 상태를 모아 패널·오버레이·버튼에 나눠 준다. */
export const RdxDevtools = ({ hotkey = DEFAULT_HOTKEY }: RdxDevtoolsProps) => {
  const [tab, setTab] = useStoredState(TAB_KEY, parseTab, firstTab, SESSION);
  const [picking, setPicking] = useState(false);
  const [boxesVisible, setBoxesVisible] = useStoredState(BOXES_KEY, parseBool, no, SESSION);
  const { result, scope: activeScope, pick, clear: clearScope } = useAnalysisScope();
  const [selected, setSelected] = useState<{ record: RequestRecord; focus?: Focus } | null>(null);
  const [hovered, setHovered] = useState<RequestRecord | null>(null);

  const { ignored, toggle: toggleIgnore } = useIgnoredEndpoints();
  const analysis = useRequestAnalysis(ignored);
  const { open, show, hide, popup, settings, updateDock, saveDock, changeDock } = usePanelVisibility();
  const { position, handlers } = useDraggable(BUTTON_SIZE, open ? hide : show);

  const startPicking = useCallback(() => {
    show();
    setSelected(null);
    setPicking((v) => !v);
  }, [show]);
  const stopPicking = useCallback(() => setPicking(false), []);
  useHotkey(hotkey, startPicking, stopPicking);
  const pickRect = useElementPicker(
    picking,
    useCallback(
      (el: Element) => {
        pick(el);
        setPicking(false);
      },
      [pick],
    ),
  );
  const wholeScreen = useCallback(() => {
    clearScope();
    setPicking(false);
  }, [clearScope]);

  const boxes = useOverlayBoxes(needsBoxes(boxesVisible, open, activeScope !== null, tab), activeScope?.fiber ?? null);
  const scopedAnalysis = useScopedAnalysis(analysis, activeScope, boxes, result);

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

  const pickTitle = settings.dock === 'window' ? '원래 창에서 요소를 클릭하세요' : `요소 선택 (Ctrl/Cmd+Shift+${hotkey.key.toUpperCase()})`;

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
          scopeName={activeScope?.name ?? null}
          onWholeScreen={wholeScreen}
          picking={picking}
          onTogglePicking={startPicking}
          pickTitle={pickTitle}
          boxesVisible={boxesVisible}
          onToggleBoxes={() => setBoxesVisible((v) => !v)}
          wasteCount={scopedAnalysis.wasteCount}
          dock={settings.dock}
          onDock={changeDock}
          onClose={hide}
        />
      }
    >
      <PanelContent
        tab={tab}
        picking={picking}
        selected={selected}
        onBack={() => setSelected(null)}
        scope={activeScope}
        result={result}
        boxes={boxes}
        analysis={scopedAnalysis}
        ignored={ignored}
        onToggleIgnore={toggleIgnore}
      />
    </Panel>
  );

  return createPortal(
    <RequestActionsProvider value={actions}>
      <div {...ownUiProps}>
        {boxesVisible && <SourceOverlay boxes={boxes} />}
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
