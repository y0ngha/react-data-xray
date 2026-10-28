import { useMemo, useRef, useState } from 'react';

import { sortRenderGroups, type RenderGroup, type RenderSort } from '../../../core/render/groups.js';
import type { Hit } from '../../../core/inspect/types.js';
import type { EndpointStat } from '../../../core/requests/endpointStats.js';
import { endpointOf } from '../../../core/requests/requestKey.js';
import { isIndexPending } from '../../../core/inspect/derivedMatch.js';
import { getRecords } from '../../../core/requests/store.js';
import { inspectFiber } from '../../../core/inspect/inspect.js';
import type { Fiber } from '../../../core/fiber/types.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';
import { useNow } from '../../hooks/useNow.js';
import { useRenderMonitoring } from '../../hooks/useRenderMonitoring.js';
import { RenderGroupRow } from './RenderGroupRow.js';
import { useRenderGroups } from './useRenderGroups.js';

const REFRESH_MS = 1000;
const MAX_GROUPS = 30;

const SORTS: ReadonlyArray<{ sort: RenderSort; label: string; title?: string }> = [
  { sort: 'avoidable', label: '줄일 수 있는 렌더순', title: '줄일 수 있는 렌더(같은 내용 새 참조, 새 콜백, 부모 렌더)가 많은 순' },
  { sort: 'count', label: '횟수순' },
  { sort: 'time', label: '시간순', title: '자식을 뺀 자기 자신의 렌더 시간 합' },
];

// 출처 검사는 비싸서, 컴포넌트가 다시 렌더되기 전(state·props 객체가 그대로)에는 지난 결과를 쓴다.
// shortcut: useContext 만 쓰는 컴포넌트는 context 값이 바뀌어도 props 가 같으면 지난 결과를 쓴다. 틀린 출처가 보고되면 context 값도 키에 넣는다.
const sources = new WeakMap<object, Hit | undefined>();

/** 렌더가 잦은 컴포넌트가 어떤 요청의 데이터를 쓰는지 같이 보여 준다. */
const sourceOf = (group: RenderGroup): Hit | undefined => {
  const fiber = group.fiber as Fiber;
  const key: unknown = fiber.memoizedState ?? fiber.memoizedProps;
  if (!key || typeof key !== 'object') return inspectFiber(fiber)[0];
  // 기억한 출처가 요청 목록에서 밀려난 파생 매칭이면 다시 찾는다(밀려난 응답 본문을 붙잡지 않게).
  const cached = sources.get(key);
  if (sources.has(key) && (!cached || cached.match === 'exact' || getRecords().includes(cached.record))) return cached;
  const source = inspectFiber(fiber)[0];
  // 색인 중에 못 찾은 것은 기억하지 않는다(1초 뒤 다시 찾는다).
  if (source || !isIndexPending()) sources.set(key, source);
  return source;
};

/** 렌더 › 분석: 최근 10초 렌더를 컴포넌트별로 묶어 이유, 줄이는 방법, 네트워크 원인을 보여 준다. */
export const RendersTab = ({
  statsByEndpoint,
  scope = null,
}: {
  statsByEndpoint: ReadonlyMap<string, EndpointStat>;
  /** 분석 대상 컴포넌트. 있으면 그 컴포넌트와 그 아래의 렌더만 본다. */
  scope?: Fiber | null;
}) => {
  useRenderMonitoring();
  const now = useNow(REFRESH_MS);
  const [sort, setSort] = useState<RenderSort>('avoidable');
  const host = useRef<HTMLDivElement>(null);
  const computed = useRenderGroups(now, scope, host, sourceOf);
  // 정렬은 보이는 줄 수와 상관없이 전체 그룹에 하지만 그룹이 이미 합쳐져 있어 싸다. 기준이 바뀔 때만 다시 한다.
  const rows = useMemo(() => {
    const sorted = sortRenderGroups(
      (computed ?? []).map((c) => c.group),
      sort,
    ).slice(0, MAX_GROUPS);
    const sourceByGroup = new Map((computed ?? []).map((c) => [c.group, c.source]));
    return sorted.map((group) => ({ group, source: sourceByGroup.get(group) }));
  }, [computed, sort]);
  const showTime = rows.some((r) => r.group.ms > 0);
  const statOf = (source: Hit | undefined) => (source ? statsByEndpoint.get(endpointOf(source.record)) : undefined);
  return (
    <div ref={host}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <Muted>렌더 분석 · 최근 10초 ·</Muted>
        {SORTS.map((s) => (
          <Button key={s.sort} active={sort === s.sort} onClick={() => setSort(s.sort)} title={s.title}>
            {s.label}
          </Button>
        ))}
      </div>
      {computed && rows.length === 0 && <Muted>아직 렌더가 없습니다. 화면을 조작해 보세요.</Muted>}
      {rows.map(({ group, source }) => (
        <RenderGroupRow key={group.name} group={group} source={source} stat={statOf(source)} showTime={showTime} />
      ))}
    </div>
  );
};
