import { auditQueryCache, CACHE_FINDING_TEXT, findQueryClients, type CacheFinding } from '../reactQuery/cacheAudit.js';
import type { RequestClass } from '../requests/classify.js';
import type { RequestRecord } from '../requests/types.js';

/** React Query 캐시키 설계 점검. 화면에 QueryClientProvider 가 없으면 found: false */
export interface ReactQuerySection {
  found: boolean;
  findings: Array<CacheFinding & { title: string; fix: string }>;
}

export const REACT_QUERY_HOW_TO_READ =
  'reactQuery.findings 는 queryKey 설계 문제다(중복 캐시, 키에 빠진 파라미터, 빗나간 무효화, staleTime 0). fix 를 따른다.';

export const buildReactQuerySection = (
  records: readonly RequestRecord[],
  classes: ReadonlyMap<number, RequestClass>,
): ReactQuerySection => {
  const clients = findQueryClients();
  return {
    found: clients.length > 0,
    findings: auditQueryCache((r) => classes.get(r.id) ?? 'ok', records, clients).map((f) =>
      Object.assign({}, f, CACHE_FINDING_TEXT[f.kind]),
    ),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REACT_QUERY_HOW_TO_READ_EXTRA: readonly string[] = [];
