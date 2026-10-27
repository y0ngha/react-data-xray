import type { InspectResult } from '../../core/inspect/types.js';
import type { RequestAnalysis } from '../hooks/useRequestAnalysis.js';
import type { Focus } from '../contexts.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { RequestDetail } from '../request/RequestDetail.js';
import { color } from '../theme.js';
import { InspectTab } from './inspect/InspectTab.js';
import { RendersTab } from './renders/RendersTab.js';
import { RequestsTab } from './requests/RequestsTab.js';
import type { Tab } from './tabs.js';
import { TimelineTab } from './timeline/TimelineTab.js';

interface PanelContentProps {
  tab: Tab;
  picking: boolean;
  selected: { record: RequestRecord; focus?: Focus } | null;
  onBack: () => void;
  result: InspectResult | null;
  analysis: RequestAnalysis;
  ignored: ReadonlySet<string>;
  onToggleIgnore: (endpoint: string) => void;
}

/** 패널 내용: 요청 상세를 보는 중이면 상세, 아니면 고른 탭 */
export const PanelContent = ({ tab, picking, selected, onBack, result, analysis, ignored, onToggleIgnore }: PanelContentProps) => (
  <>
    {picking && <div style={{ color: color.accent, marginBottom: 8 }}>화면의 요소를 클릭하세요. (Esc 취소)</div>}
    {/* 요청마다 새로 만들어, 이전 요청 상세의 상태(화면에서 강조 등)가 남지 않게 한다. */}
    {selected && <RequestDetail key={selected.record.id} record={selected.record} focus={selected.focus} onBack={onBack} />}
    {/* 상세를 여는 동안에도 탭 상태(필터, 타임라인 멈춤 등)를 잃지 않도록 숨기기만 한다.
        hidden 속성은 앱의 전역 CSS 에 질 수 있어 인라인 style 로 숨긴다. */}
    <div style={{ display: selected ? 'none' : undefined }}>
      {tab === 'inspect' && <InspectTab result={result} stats={analysis.statsByEndpoint} />}
      {tab === 'requests' && (
        <RequestsTab records={analysis.records} stats={analysis.stats} ignored={ignored} onToggleIgnore={onToggleIgnore} />
      )}
      {tab === 'timeline' && <TimelineTab records={analysis.records} />}
      {tab === 'renders' && <RendersTab statsByEndpoint={analysis.statsByEndpoint} />}
    </div>
  </>
);
