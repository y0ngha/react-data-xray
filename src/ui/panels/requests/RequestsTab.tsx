import { useMemo, useState } from 'react';

import { getEndpointStats, type EndpointStat } from '../../../core/requests/endpointStats.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { Button } from '../../components/Button.js';
import { useRequestActions } from '../../contexts.js';
import { color } from '../../theme.js';
import { CacheAuditView } from './CacheAuditView.js';
import { EndpointRow } from './EndpointRow.js';
import { RequestLogRow } from './RequestLogRow.js';

type View = 'endpoints' | 'log' | 'cache';

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
  const [currentOnly, setCurrentOnly] = useState(false);
  const route = currentOnly ? window.location.pathname : undefined;
  const logs = [...records].reverse().filter((r) => (!filter || endpointOf(r) === filter) && (route === undefined || r.route === route));
  const { classOf } = useRequestActions();
  // 경로 필터 중에는 그 경로에서 보낸 요청만으로 건수·낭비를 다시 센다(전 경로 합계를 보이지 않는다). 분류는 전체 기록 기준 그대로다.
  const shownStats = useMemo(() => {
    if (route === undefined) return stats;
    const own = records.filter((r) => r.route === route);
    return getEndpointStats(own, new Map(own.map((r) => [r.id, classOf(r)])));
  }, [route, stats, records, classOf]);
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
        <Button active={view === 'cache'} onClick={() => setView('cache')} title="React Query 캐시키 설계 점검">
          React Query
        </Button>
        {view === 'log' && filter && (
          <Button onClick={() => setFilter(null)} title="필터 해제">
            {filter} ✕
          </Button>
        )}
        <Button active={currentOnly} onClick={() => setCurrentOnly(!currentOnly)} title="지금 경로(location.pathname)에서 보낸 요청만 보기">
          지금 경로만
        </Button>
        <span style={{ color: color.muted, marginLeft: 'auto' }}>최근 {records.length}건</span>
      </div>
      {view === 'cache' && <CacheAuditView records={records} />}
      {view === 'endpoints' &&
        shownStats.map((stat) => (
          <EndpointRow
            key={stat.endpoint}
            stat={stat}
            ignored={ignored.has(stat.endpoint)}
            route={route}
            onSelect={showEndpoint}
            onToggleIgnore={onToggleIgnore}
          />
        ))}
      {view === 'log' && logs.map((record) => <RequestLogRow key={record.id} record={record} />)}
    </div>
  );
};
