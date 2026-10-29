import { Button } from '../components/Button.js';
import { TabGroup } from '../components/TabGroup.js';
import type { Dock } from '../hooks/useDockSettings.js';
import { color } from '../theme.js';
import { CompareReports } from './compare/CompareReports.js';
import { DockPicker } from './DockPicker.js';
import { ResetButton } from './ResetButton.js';
import { TabReportButton } from './TabReportButton.js';
import { TAB_GROUPS, type Tab } from './tabs.js';

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
 * 두 축을 나눠 보여 준다.
 * - 대상: 무엇을 볼지(화면 전체, 또는 요소 선택으로 고른 컴포넌트와 그 아래)
 * - 관점: 그 대상의 무엇을 볼지(데이터 출처, 네트워크, 렌더)
 */
export const PanelToolbar = (props: PanelToolbarProps) => (
  <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: `1px solid ${color.border}`, flexWrap: 'wrap', alignItems: 'center' }}>
    <TabGroup label="Target">
      <Button active={props.scopeName === null && !props.picking} onClick={props.onWholeScreen} title="Analyze whole page">
        ▦ Whole page
      </Button>
      <Button active={props.picking} onClick={props.onTogglePicking} title={props.pickTitle}>
        ⌖ Pick element
      </Button>
      {props.scopeName && (
        <Button active onClick={props.onWholeScreen} title="Clear selection, back to whole page">
          &lt;{props.scopeName}&gt; ✕
        </Button>
      )}
      <Button active={props.boxesVisible} onClick={props.onToggleBoxes} title="Draw data source boxes on the page">
        {props.boxesVisible ? '☑' : '☐'} Boxes
      </Button>
    </TabGroup>
    <span style={{ flex: 1 }} />
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
    <span style={{ width: 8 }} />
    <ResetButton />
    <TabReportButton />
    <CompareReports />
    <DockPicker dock={props.dock} onChange={props.onDock} />
    <Button onClick={props.onClose} title="Close">
      ✕
    </Button>
  </div>
);
