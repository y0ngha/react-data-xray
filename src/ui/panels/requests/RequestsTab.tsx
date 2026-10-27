import { useState } from 'react';

import type { EndpointStat } from '../../../core/requests/endpointStats.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { Button } from '../../components/Button.js';
import { color } from '../../theme.js';
import { EndpointRow } from './EndpointRow.js';
import { RequestLogRow } from './RequestLogRow.js';

type View = 'endpoints' | 'log';

interface RequestsTabProps {
  records: readonly RequestRecord[];
  stats: readonly EndpointStat[];
  ignored: ReadonlySet<string>;
  onToggleIgnore: (endpoint: string) => void;
}

/** 네트워크 › 요청: 엔드포인트별 지표와 전체 기록. 엔드포인트를 누르면 그 요청만 기록에 보여 준다. */
export const RequestsTab = ({ records, stats, ignored, onToggleIgnore }: RequestsTabProps) => {
  const [view, setView] = useState<View>('endpoints');
  const [filter, setFilter] = useState<string | null>(null);
  const logs = [...records].reverse().filter((r) => !filter || endpointOf(r) === filter);
  const showEndpoint = (endpoint: string) => {
    setFilter(endpoint);
    setView('log');
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <Button active={view === 'endpoints'} onClick={() => setView('endpoints')}>
          엔드포인트별
        </Button>
        <Button active={view === 'log'} onClick={() => setView('log')}>
          전체 기록
        </Button>
        {view === 'log' && filter && (
          <Button onClick={() => setFilter(null)} title="필터 해제">
            {filter} ✕
          </Button>
        )}
        <span style={{ color: color.muted, marginLeft: 'auto' }}>최근 {records.length}건</span>
      </div>
      {view === 'endpoints'
        ? stats.map((stat) => (
            <EndpointRow
              key={stat.endpoint}
              stat={stat}
              ignored={ignored.has(stat.endpoint)}
              onSelect={showEndpoint}
              onToggleIgnore={onToggleIgnore}
            />
          ))
        : logs.map((record) => <RequestLogRow key={record.id} record={record} />)}
    </div>
  );
};
