import type { Box } from '../../../core/inspect/types.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { groupBy } from '../../../shared/collections.js';
import { Muted } from '../../components/Muted.js';
import { ClassBadge } from '../../request/ClassBadge.js';
import { RequestLink } from '../../request/RequestLink.js';
import { color, rowStyle } from '../../theme.js';

interface ApiUse {
  endpoint: string;
  /** 가장 최근 요청(누르면 상세가 열린다) */
  latest: RequestRecord;
  /** 컴포넌트 이름 → 화면에 있는 개수 */
  components: Array<[string, number]>;
}

/** 박스(데이터 출처가 있는 컴포넌트)를 API 별로 묶는다. 컴포넌트가 많은 API 부터 */
export const groupByApi = (boxes: readonly Box[]): ApiUse[] =>
  Array.from(
    groupBy(boxes, (b) => endpointOf(b.hit.record)),
    ([endpoint, list]) => ({
      endpoint,
      latest: list.reduce((a, b) => (b.hit.record.id > a.hit.record.id ? b : a)).hit.record,
      components: Array.from(
        groupBy(list, (b) => b.name),
        ([name, same]): [string, number] => [name, same.length],
      ),
    }),
  ).sort((a, b) => b.components.length - a.components.length || a.endpoint.localeCompare(b.endpoint));

/** 데이터 관점: 분석 대상 안에서 어떤 API 응답을 어떤 컴포넌트가 쓰는지 */
export const SourcesByApi = ({ boxes, title }: { boxes: readonly Box[]; title: string }) => {
  const uses = groupByApi(boxes);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: color.heading }}>{title}</div>
      {uses.length === 0 && <Muted>No component found that receives response data as props.</Muted>}
      {uses.map((use) => (
        <div key={use.endpoint} style={rowStyle}>
          <RequestLink record={use.latest}>
            {use.endpoint} <ClassBadge record={use.latest} />
          </RequestLink>
          <Muted>{use.components.map(([name, count]) => `<${name}>${count > 1 ? ` ×${count}` : ''}`).join(', ')}</Muted>
        </div>
      ))}
    </div>
  );
};
