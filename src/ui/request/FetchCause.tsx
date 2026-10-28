import { useMemo } from 'react';

import { overlapCancelOf } from '../../core/reactQuery/cacheAudit.js';
import { describeFetchCause } from '../../core/reactQuery/fetchCause.js';
import { flushQueue } from '../../core/scheduler/idleQueue.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { Muted } from '../components/Muted.js';
import { Section } from '../components/Section.js';
import { useRequestActions } from '../contexts.js';

const FLUSH_LIMIT_MS = 1000;

/** React Query 요청이 왜 나갔는지(관찰자와 fetch 원인, 판단 근거, 같은 응답 낭비면 처방). 겹친 무효화로 취소된 요청이면 그 원인도. */
export const FetchCause = ({ record }: { record: RequestRecord }) => {
  const wasteful = useRequestActions().classOf(record) === 'same-response';
  // 사용자 조회: 미뤄 둔 분석을 먼저 마친 뒤(안 그러면 빈 결과가 굳는다) 원인과 취소를 함께 구한다.
  const { info, cancel } = useMemo(() => {
    flushQueue(FLUSH_LIMIT_MS);
    return {
      info: describeFetchCause(record, wasteful),
      cancel: overlapCancelOf(record),
    };
  }, [record, wasteful]);
  if (!info && !cancel) return null;
  return (
    <Section title="fetch 원인">
      {info && (
        <div>
          {info.label}
          <Muted>
            {info.observer ? `${info.observer} · ` : ''}
            {info.queryKey}
            {info.evidence && ` · ${info.evidence}`}
          </Muted>
          {info.fix && <div>{info.fix}</div>}
        </div>
      )}
      {cancel && (
        <div>
          무효화가 겹쳐 취소됨
          <Muted>앞 무효화: {cancel[0].split('\n')[0]}</Muted>
          <Muted>뒤 무효화: {cancel[1].split('\n')[0]}</Muted>
        </div>
      )}
    </Section>
  );
};
