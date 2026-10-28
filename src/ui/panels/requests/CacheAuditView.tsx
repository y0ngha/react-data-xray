import { auditQueryCache, CACHE_FINDING_TEXT, findingId, findQueryClients } from '../../../core/reactQuery/cacheAudit.js';
import type { RequestRecord } from '../../../core/requests/types.js';
import { Muted } from '../../components/Muted.js';
import { useRequestActions } from '../../contexts.js';
import { useNow } from '../../hooks/useNow.js';
import { color, rowStyle } from '../../theme.js';

const REFRESH_MS = 1000;

/** 네트워크 › 요청 › React Query: queryKey 설계 문제(중복 캐시, 키에 빠진 파라미터, 빗나간 무효화, staleTime 0) */
export const CacheAuditView = ({ records }: { records: readonly RequestRecord[] }) => {
  useNow(REFRESH_MS);
  const { classOf } = useRequestActions();
  if (findQueryClients().length === 0) return <Muted>화면에서 React Query(QueryClientProvider)를 찾지 못했습니다.</Muted>;
  const findings = auditQueryCache(classOf, records);
  if (findings.length === 0) return <Muted>캐시키 설계 문제를 찾지 못했습니다. 화면을 조작하면 다시 확인합니다.</Muted>;
  return (
    <div>
      {findings.map((f) => (
        <div key={findingId(f)} style={rowStyle}>
          <div style={{ color: f.kind === 'invalidate-unloaded' ? color.muted : color.warn }}>{CACHE_FINDING_TEXT[f.kind].title}</div>
          <Muted>
            queryKey: {f.keys.join(' · ')}
            {f.count ? ` · 키 ${f.count}개` : ''}
          </Muted>
          {f.requests.length > 0 && <Muted>요청: {f.requests.join(' · ')}</Muted>}
          <div>{CACHE_FINDING_TEXT[f.kind].fix}</div>
          {f.stack && <Muted>{f.stack.split('\n').slice(1, 3).join(' ')}</Muted>}
        </div>
      ))}
    </div>
  );
};
