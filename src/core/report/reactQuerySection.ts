import { auditQueryCache, CACHE_FINDING_TEXT, findQueryClients, type CacheFinding } from '../reactQuery/cacheAudit.js';
import { describeFetchCause, type FetchCauseInfo } from '../reactQuery/fetchCause.js';
import type { RequestClass } from '../requests/classify.js';
import type { RequestRecord } from '../requests/types.js';

/** React Query 캐시키 설계 점검. 화면에 QueryClientProvider 가 없으면 found: false */
export interface ReactQuerySection {
  found: boolean;
  findings: Array<CacheFinding & { title: string; fix: string }>;
  /** React Query 요청의 fetch 원인(관찰자·queryKey·원인별로 묶음). 없으면 필드를 두지 않는다. */
  fetchCauses?: Array<Omit<FetchCauseInfo, 'label'> & { causeLabel: string; count: number }>;
}

const MAX_FETCH_CAUSES = 20;

const fetchCausesOf = (records: readonly RequestRecord[], classes: ReadonlyMap<number, RequestClass>): ReactQuerySection['fetchCauses'] => {
  const groups = new Map<string, NonNullable<ReactQuerySection['fetchCauses']>[number]>();
  records.forEach((r) => {
    const info = describeFetchCause(r, classes.get(r.id) === 'same-response');
    if (!info) return;
    const { label, ...rest } = info;
    const id = JSON.stringify([rest.queryKey, rest.observer, rest.cause, rest.fix]);
    const g = groups.get(id);
    if (g) g.count += 1;
    else groups.set(id, { ...rest, causeLabel: label, count: 1 });
  });
  const list = Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FETCH_CAUSES);
  return list.length > 0 ? list : undefined;
};

export const REACT_QUERY_HOW_TO_READ =
  'reactQuery.findings lists queryKey design problems (duplicate cache, parameter missing from key, mismatched invalidation, staleTime 0). Follow the fix field.';

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
    fetchCauses: fetchCausesOf(records, classes),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REACT_QUERY_HOW_TO_READ_EXTRA: readonly string[] = [
  'reactQuery.findings: invalidate-unloaded means the key shape matched but the specific query does not exist yet — a valid invalidation, nothing to fix. double-invalidate means overlapping invalidations where the second cancelled the first refetch; remove one of the two call sites in stacks (requests shows the cancelled request). count is the number of occurrences grouped at the same call site (for invalidate-* it is the number of keys, so keys shows a prefix; for double-invalidate it is the overlap count).',
  'reactQuery.fetchCauses explains why each React Query request was issued (cause: initial — first fetch, mount/enabled — observer mounted or enabled turned on while stale, key-change — observer queryKey changed, invalidate — invalidation, focus — window focus or reconnect, interval — polling). observer is the component that renders the useQuery call, evidence shows the staleTime and time since last update at that moment. When fix is present the same response was fetched again wastefully; follow the prescribed fix (e.g., increase staleTime).',
];
