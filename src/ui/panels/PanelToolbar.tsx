import { useReducer } from 'react';

import { getResetAt } from '../../core/report/reportApi.js';
import { formatTime } from '../../shared/format.js';
import { Button } from '../components/Button.js';
import { TabGroup } from '../components/TabGroup.js';
import type { Dock } from '../hooks/useDockSettings.js';
import { useStoredState } from '../hooks/useStoredState.js';
import { color } from '../theme.js';
import { MEASURE_KEY, parseBool } from '../viewState.js';
import { CompareReports } from './compare/CompareReports.js';
import { SnapshotButton } from './compare/SnapshotButton.js';
import { DockPicker } from './DockPicker.js';
import { ResetButton } from './ResetButton.js';
import { TabReportButton } from './TabReportButton.js';
import { TAB_GROUPS, type Tab } from './tabs.js';

const SESSION = { area: 'session' } as const;
const no = () => false;

interface PanelToolbarProps {
  /** 지금 보이는 관점 탭. 요청 상세를 보는 중이면 null */
  activeTab: Tab | null;
  onTab: (tab: Tab) => void;
  /** 고른 분석 대상 컴포넌트 이름. 화면 전체면 null */
  scopeName: string | null;
  onWholeScreen: () => void;
  picking: boolean;
  onTogglePicking: () => void;
  pickTitle: string;
  boxesVisible: boolean;
  onToggleBoxes: () => void;
  /** 네트워크 › 요청 탭에 붙일 낭비 엔드포인트 수 */
  wasteCount: number;
  dock: Dock;
  onDock: (dock: Dock) => void;
  onClose: () => void;
}

/**
 * 두 줄로 나눈다.
 * - 1줄: Target · View · Measure 토글 / Window(도킹·닫기, marginLeft:auto 로 맨 끝)
 * - 2줄(Measure 펼침 시): Clear records → Save → Compare → Copy report path
 */
export const PanelToolbar = (props: PanelToolbarProps) => {
  const [measureOpen, setMeasureOpen] = useStoredState(MEASURE_KEY, parseBool, no, SESSION);
  // ResetButton 이 Measure 행에 있어 클릭해도 PanelToolbar 가 다시 그려지지 않으므로, 강제로 다시 그려
  // `since HH:MM` 힌트를 갱신한다.
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  const at = getResetAt();

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: 8,
        borderBottom: `1px solid ${color.border}`,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {/* ── 1줄: 그룹들 ── */}
      <TabGroup label="Target">
        <Button active={props.scopeName === null && !props.picking} onClick={props.onWholeScreen} title="Analyze whole page">
          ▦ Whole page
        </Button>
        <Button active={props.picking} onClick={props.onTogglePicking} title={props.pickTitle}>
          ⌖ Pick element
        </Button>
        {props.scopeName && (
          <Button active onClick={props.onWholeScreen} title={`<${props.scopeName}> — clear selection`}>
            <span style={{ display: 'inline-block', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}>
              &lt;{props.scopeName}&gt;
            </span>
            {' ✕'}
          </Button>
        )}
        <Button active={props.boxesVisible} onClick={props.onToggleBoxes} title="Draw data source boxes on the page">
          {props.boxesVisible ? '☑' : '☐'} Boxes
        </Button>
      </TabGroup>

      <TabGroup label="View">
        {TAB_GROUPS.map((group) =>
          group.tabs.map((t) => (
            <Button key={t.tab} active={props.activeTab === t.tab} onClick={() => props.onTab(t.tab)} title={`${group.label} › ${t.title}`}>
              {group.tabs.length > 1 ? `${group.label} ${t.label}` : group.label}
              {t.tab === 'requests' && props.wasteCount > 0 && ` ⚠${props.wasteCount}`}
            </Button>
          )),
        )}
      </TabGroup>

      <TabGroup>
        <Button active={measureOpen} onClick={() => setMeasureOpen(!measureOpen)} title="Show measurement tools">
          Measure {measureOpen ? '▴' : '▾'}
        </Button>
        {at !== null && <span style={{ color: color.muted, fontSize: 11, whiteSpace: 'nowrap' }}>since {formatTime(at).slice(0, 5)}</span>}
      </TabGroup>

      {/* 창 묶음: 맨 끝에 고정(marginLeft:auto), 줄 바꿈 없이 한 덩어리로 */}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 2, flexWrap: 'nowrap' }}>
        <DockPicker dock={props.dock} onChange={props.onDock} />
        <Button onClick={props.onClose} title="Close">
          ✕
        </Button>
      </span>

      {/* ── 2줄: Measure 펼침 시에만 ── */}
      {measureOpen && (
        <div style={{ flexBasis: '100%', display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <ResetButton onReset={forceUpdate} />
          <span style={{ color: color.muted }}>›</span>
          <SnapshotButton />
          <span style={{ color: color.muted }}>›</span>
          <CompareReports />
          <span style={{ color: color.muted }}>›</span>
          <TabReportButton />
        </div>
      )}
    </div>
  );
};
