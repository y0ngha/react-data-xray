import type { Fiber } from '../../core/fiber/types.js';
import type { Box, InspectResult } from '../../core/inspect/types.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { Muted } from '../components/Muted.js';
import type { Focus } from '../contexts.js';
import type { RequestAnalysis } from '../hooks/useRequestAnalysis.js';
import { RequestDetail } from '../request/RequestDetail.js';
import { color } from '../theme.js';
import { SourcesByApi } from './data/SourcesByApi.js';
import { InspectTab } from './inspect/InspectTab.js';
import { RendersTab } from './renders/RendersTab.js';
import { RequestsTab } from './requests/RequestsTab.js';
import type { Tab } from './tabs.js';
import { TimelineTab } from './timeline/TimelineTab.js';

/** 분석 대상. 화면 전체면 null */
export interface Scope {
  fiber: Fiber;
  name: string;
}

interface PanelContentProps {
  tab: Tab;
  picking: boolean;
  selected: { record: RequestRecord; focus?: Focus } | null;
  onBack: () => void;
  scope: Scope | null;
  /** 요소 선택으로 클릭한 요소의 출처(대상이 화면 전체면 쓰지 않는다) */
  result: InspectResult | null;
  /** 분석 대상 안에서 데이터 출처가 있는 컴포넌트 */
  boxes: readonly Box[];
  /** 분석 대상이 쓰는 요청만 남긴 분석 */
  analysis: RequestAnalysis;
  ignored: ReadonlySet<string>;
  onToggleIgnore: (endpoint: string) => void;
}

/** 패널 내용: 요청 상세를 보는 중이면 상세, 아니면 고른 관점으로 분석 대상을 보여 준다. */
export const PanelContent = ({
  tab,
  picking,
  selected,
  onBack,
  scope,
  result,
  boxes,
  analysis,
  ignored,
  onToggleIgnore,
}: PanelContentProps) => (
  <>
    {picking && <div style={{ color: color.accent, marginBottom: 8 }}>Click an element on the page to inspect it. (Esc to cancel)</div>}
    {/* 요청마다 새로 만들어, 이전 요청 상세의 상태(화면에서 강조 등)가 남지 않게 한다. */}
    {selected && <RequestDetail key={selected.record.id} record={selected.record} focus={selected.focus} onBack={onBack} />}
    {/* 상세를 여는 동안에도 탭 상태(필터, 타임라인 멈춤 등)를 잃지 않도록 숨기기만 한다.
        hidden 속성은 앱의 전역 CSS 에 질 수 있어 인라인 style 로 숨긴다. */}
    <div style={{ display: selected ? 'none' : undefined }}>
      {scope && tab !== 'inspect' && (
        <Muted>
          Scope: &lt;{scope.name}&gt;{tab !== 'renders' && ` · ${analysis.records.length} req inside`}
        </Muted>
      )}
      {tab === 'inspect' && (
        <>
          {/* 클릭한 요소의 출처. 컴포넌트 밖을 눌러 대상을 못 정했어도 결과는 보여 준다. */}
          <InspectTab result={result} stats={analysis.statsByEndpoint} />
          <SourcesByApi
            boxes={boxes}
            title={scope ? `Components using data inside <${scope.name}>` : 'Components using data on the page'}
          />
        </>
      )}
      {tab === 'requests' && (
        <RequestsTab records={analysis.records} stats={analysis.stats} ignored={ignored} onToggleIgnore={onToggleIgnore} />
      )}
      {tab === 'timeline' && <TimelineTab records={analysis.records} />}
      {tab === 'renders' && <RendersTab statsByEndpoint={analysis.statsByEndpoint} scope={scope?.fiber ?? null} />}
    </div>
  </>
);
