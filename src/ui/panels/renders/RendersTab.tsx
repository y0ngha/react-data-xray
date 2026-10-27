import { useState } from 'react';

import { groupRenders, sortRenderGroups, type RenderSort } from '../../../core/render/groups.js';
import { getTopRenders } from '../../../core/render/monitor.js';
import { inspectFiber } from '../../../core/inspect/inspect.js';
import type { Fiber } from '../../../core/fiber/types.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';
import { useNow } from '../../hooks/useNow.js';
import { useRenderMonitoring } from '../../hooks/useRenderMonitoring.js';
import { RenderGroupRow } from './RenderGroupRow.js';

const REFRESH_MS = 1000;
const MAX_GROUPS = 30;
const MAX_RENDERS = 500;

const SORTS: ReadonlyArray<{ sort: RenderSort; label: string; title?: string }> = [
  { sort: 'avoidable', label: '줄일 수 있는 렌더순', title: '줄일 수 있는 렌더(같은 내용 새 참조, 새 콜백, 부모 렌더)가 많은 순' },
  { sort: 'count', label: '횟수순' },
  { sort: 'time', label: '시간순', title: '자식을 뺀 자기 자신의 렌더 시간 합' },
];

/** 렌더 › 분석: 최근 10초 렌더를 컴포넌트별로 묶어 이유, 줄이는 방법, 네트워크 원인을 보여 준다. */
export const RendersTab = () => {
  useRenderMonitoring();
  const now = useNow(REFRESH_MS);
  const [sort, setSort] = useState<RenderSort>('avoidable');
  const groups = sortRenderGroups(groupRenders(getTopRenders(MAX_RENDERS, now)), sort).slice(0, MAX_GROUPS);
  const showTime = groups.some((g) => g.ms > 0);
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <Muted>렌더 분석 · 최근 10초 ·</Muted>
        {SORTS.map((s) => (
          <Button key={s.sort} active={sort === s.sort} onClick={() => setSort(s.sort)} title={s.title}>
            {s.label}
          </Button>
        ))}
      </div>
      {groups.length === 0 && <Muted>아직 렌더가 없습니다. 화면을 조작해 보세요.</Muted>}
      {groups.map((group) => (
        <RenderGroupRow key={group.name} group={group} source={inspectFiber(group.fiber as Fiber)[0]} showTime={showTime} />
      ))}
    </div>
  );
};
