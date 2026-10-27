import { Button } from '../components/Button.js';
import { TabGroup } from '../components/TabGroup.js';
import type { Dock } from '../hooks/useDockSettings.js';
import { color } from '../theme.js';
import { DockPicker } from './DockPicker.js';
import { TAB_GROUPS, type Tab } from './tabs.js';

interface PanelToolbarProps {
  /** 지금 보이는 탭. 요청 상세를 보는 중이면 null */
  activeTab: Tab | null;
  onTab: (tab: Tab) => void;
  picking: boolean;
  onTogglePicking: () => void;
  showAll: boolean;
  onToggleShowAll: () => void;
  /** 네트워크 › 요청 탭에 붙일 낭비 엔드포인트 수 */
  wasteCount: number;
  dock: Dock;
  onDock: (dock: Dock) => void;
  onClose: () => void;
  pickTitle: string;
}

export const PanelToolbar = (props: PanelToolbarProps) => (
  <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: `1px solid ${color.border}`, flexWrap: 'wrap' }}>
    <Button active={props.picking} onClick={props.onTogglePicking} title={props.pickTitle}>
      ⌖ 요소 선택
    </Button>
    <Button active={props.showAll} onClick={props.onToggleShowAll} title="데이터 출처가 있는 요소를 모두 표시">
      ▦ 전체 표시
    </Button>
    <span style={{ flex: 1 }} />
    {TAB_GROUPS.map((group) => (
      <TabGroup key={group.label} label={group.label}>
        {group.tabs.map((t) => (
          <Button key={t.tab} active={props.activeTab === t.tab} onClick={() => props.onTab(t.tab)} title={t.title}>
            {t.label}
            {t.tab === 'requests' && props.wasteCount > 0 && ` ⚠${props.wasteCount}`}
          </Button>
        ))}
      </TabGroup>
    ))}
    <span style={{ width: 8 }} />
    <DockPicker dock={props.dock} onChange={props.onDock} />
    <Button onClick={props.onClose} title="닫기">
      ✕
    </Button>
  </div>
);
