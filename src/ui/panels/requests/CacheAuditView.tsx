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
  if (findQueryClients().length === 0) return <Muted>React Query (QueryClientProvider) not found on the page.</Muted>;
  const findings = auditQueryCache(classOf, records);
  if (findings.length === 0) return <Muted>No cache key issues found. Interact with the page to recheck.</Muted>;
  return (
    <div>
      {findings.map((f) => (
        <div key={findingId(f)} style={rowStyle}>
          <div
            style={{
              color: f.kind === 'invalidate-unloaded' ? color.muted : color.warn,
            }}
          >
            {CACHE_FINDING_TEXT[f.kind].title}
          </div>
          <Muted>
            queryKey: {f.keys.join(' · ')}
            {f.count ? (f.kind === 'double-invalidate' ? ` · ×${f.count}` : ` · ${f.count} keys`) : ''}
          </Muted>
          {f.requests.length > 0 && <Muted>requests: {f.requests.join(' · ')}</Muted>}
          <div>{CACHE_FINDING_TEXT[f.kind].fix}</div>
          {f.stacks
            ? f.stacks.map((st, i) => (
                <Muted key={`${i ? 'after' : 'before'}${st}`}>{`${i ? 'after' : 'before'}: ${st.split('\n')[0]}`}</Muted>
              ))
            : f.stack && <Muted>{f.stack.split('\n').slice(1, 3).join(' ')}</Muted>}
        </div>
      ))}
    </div>
  );
};
