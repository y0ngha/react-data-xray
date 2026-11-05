import { useMemo, useState } from 'react';

import { getEndpointStats, type EndpointStat } from '../../../core/requests/endpointStats.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { toIgnoreMatcher, type IgnoreMatcher } from '../../../shared/ignoredEndpoints.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';
import { UNUSED_TITLE } from '../../request/ClassBadge.js';
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
  /** 패널·코드 무시를 합친 판정(useIgnoredEndpoints). 패널 목록만 주면 지금 설정과 합친다 */
  ignored: IgnoreMatcher | ReadonlySet<string>;
  onToggleIgnore: (endpoint: string) => void;
}

/**
 * 무시로 저장했지만 지금 기록의 어느 엔드포인트와도 맞지 않는 키. 엔드포인트 이름 규칙이 바뀐 옛 키(`POST /graphql` 처럼
 * 지금은 연산별로 나뉜 것)는 줄이 없어 풀 수 없으므로 여기서 지운다. 비교는 지금처럼 정확히 같은 이름끼리다.
 */
const UnseenIgnored = ({
  ignored,
  stats,
  onToggleIgnore,
}: Pick<RequestsTabProps, 'stats' | 'onToggleIgnore'> & { ignored: IgnoreMatcher }) => {
  const seen = new Set(stats.map((s) => s.endpoint));
  // 패널에서 고른 키만 지울 수 있다. 코드로도 무시한 키는 지워도 다시 무시되므로 보이지 않는다.
  const unseen = [...ignored.panel].filter((e) => !seen.has(e) && ignored.sourceOf(e) === 'panel');
  if (!unseen.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <Muted>Ignored but not seen in current requests</Muted>
      {unseen.map((endpoint) => (
        <div key={endpoint} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <span
            title={endpoint}
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: color.muted }}
          >
            {endpoint}
          </span>
          <Button subtle onClick={() => onToggleIgnore(endpoint)} title="Remove from the ignore list">
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
};

/** 네트워크 › 요청: 엔드포인트별 지표와 전체 기록. 엔드포인트를 누르면 그 요청만 기록에 보여 준다. */
export const RequestsTab = ({ records, stats, ignored: ignoredInput, onToggleIgnore }: RequestsTabProps) => {
  const ignored = toIgnoreMatcher(ignoredInput);
  const [view, setView] = useState<View>('endpoints');
  const [filter, setFilter] = useState<string | null>(null);
  const [currentOnly, setCurrentOnly] = useState(false);
  // 쓰는 컴포넌트를 못 찾은 응답(unused)만 보인다. 엔드포인트 보기는 그런 요청이 있는 줄만 남긴다.
  const [unusedOnly, setUnusedOnly] = useState(false);
  const route = currentOnly ? window.location.pathname : undefined;
  const logs = [...records]
    .reverse()
    .filter((r) => (!filter || endpointOf(r) === filter) && (route === undefined || r.route === route) && (!unusedOnly || r.unused));
  const { classOf } = useRequestActions();
  // 경로 필터 중에는 그 경로에서 보낸 요청만으로 건수·낭비를 다시 센다(전 경로 합계를 보이지 않는다). 분류는 전체 기록 기준 그대로다.
  const routeStats = useMemo(() => {
    if (route === undefined) return stats;
    const own = records.filter((r) => r.route === route);
    return getEndpointStats(own, new Map(own.map((r) => [r.id, classOf(r)])));
  }, [route, stats, records, classOf]);
  const shownStats = unusedOnly ? routeStats.filter((s) => s.unused) : routeStats;
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
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
        <Button active={unusedOnly} onClick={() => setUnusedOnly(!unusedOnly)} title={`Show only responses marked unused. ${UNUSED_TITLE}`}>
          Unused
        </Button>
        <span style={{ color: color.muted, marginLeft: 'auto' }}>{records.length} req</span>
      </div>
      {view === 'cache' && <CacheAuditView records={records} />}
      {view === 'endpoints' &&
        shownStats.map((stat) => (
          <EndpointRow
            key={stat.endpoint}
            stat={stat}
            ignored={ignored.sourceOf(stat.endpoint)}
            route={route}
            focus={focus?.key === stat.endpoint ? focus : undefined}
            onSelect={showEndpoint}
            onToggleIgnore={onToggleIgnore}
          />
        ))}
      {view === 'endpoints' && <UnseenIgnored ignored={ignored} stats={stats} onToggleIgnore={onToggleIgnore} />}
      {view === 'log' && logs.map((record) => <RequestLogRow key={record.id} record={record} />)}
    </div>
  );
};
