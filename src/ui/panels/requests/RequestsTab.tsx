import { useMemo, useState } from 'react';

import { getEndpointStats, type EndpointStat } from '../../../core/requests/endpointStats.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { Button } from '../../components/Button.js';
import { useRequestActions } from '../../contexts.js';
import { useFocusedItem } from '../../viewState.js';
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
  const focus = useFocusedItem('requests');
  // 배지 내역에서 엔드포인트를 골라 왔으면 엔드포인트별 보기로 돌린다(그 줄이 보이게).
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus) setView('endpoints');
  }
  const showEndpoint = (endpoint: string) => {
    setFilter(endpoint);
    setView('log');
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <Button active={view === 'endpoints'} onClick={() => setView('endpoints')}>
          By endpoint
        </Button>
        <Button active={view === 'log'} onClick={() => setView('log')}>
          All requests
        </Button>
        <Button active={view === 'cache'} onClick={() => setView('cache')} title="Check React Query cache key design">
          React Query
        </Button>
        {view === 'log' && filter && (
          <Button onClick={() => setFilter(null)} title="Clear filter">
            {filter} ✕
          </Button>
        )}
        <Button
          active={currentOnly}
          onClick={() => setCurrentOnly(!currentOnly)}
          title="Show only requests from the current route (location.pathname)"
        >
          This route
        </Button>
        <span style={{ color: color.muted, marginLeft: 'auto' }}>{records.length} req</span>
      </div>
      {view === 'cache' && <CacheAuditView records={records} />}
      {view === 'endpoints' &&
        shownStats.map((stat) => (
          <EndpointRow
            key={stat.endpoint}
            stat={stat}
            ignored={ignored.has(stat.endpoint)}
            route={route}
            focus={focus?.key === stat.endpoint ? focus : undefined}
            onSelect={showEndpoint}
            onToggleIgnore={onToggleIgnore}
          />
        ))}
      {view === 'log' && logs.map((record) => <RequestLogRow key={record.id} record={record} />)}
    </div>
  );
};
