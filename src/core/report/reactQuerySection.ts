import { auditQueryCache, CACHE_FINDING_TEXT, findQueryClients, shownStacks, type CacheFinding } from '../reactQuery/cacheAudit.js';
import { describeFetchCause, type FetchCauseInfo } from '../reactQuery/fetchCause.js';
import type { RequestClass } from '../requests/classify.js';
import type { RequestRecord } from '../requests/types.js';

/** React Query 캐시키 설계 점검. 화면에 QueryClientProvider 가 없으면 found: false */
export interface ReactQuerySection {
  found: boolean;
  findings: Array<Omit<CacheFinding, 'resolvedStack' | 'resolvedStacks'> & { title: string; fix: string }>;
  /** React Query 요청의 fetch 원인(관찰자·queryKey·원인별로 묶음). 없으면 필드를 두지 않는다. */
  fetchCauses?: Array<Omit<FetchCauseInfo, 'label'> & { causeLabel: string; count: number }>;
  /** fetchCauses 상한(MAX_FETCH_CAUSES 묶음) 밖으로 빠진 묶음 수. 빠진 것이 없으면 0. compare 가 상한 때문에 빠진 묶음을 사라진 것으로 보지 않게 한다 */
  fetchCausesOmitted: number;
}

export const MAX_FETCH_CAUSES = 20;

const fetchCausesOf = (
  records: readonly RequestRecord[],
  classes: ReadonlyMap<number, RequestClass>,
): Pick<ReactQuerySection, 'fetchCauses' | 'fetchCausesOmitted'> => {
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
  const all = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  const list = all.slice(0, MAX_FETCH_CAUSES);
  return { fetchCauses: list.length > 0 ? list : undefined, fetchCausesOmitted: all.length - list.length };
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
      // 호출 위치는 원본 위치로 바뀐 것이 있으면 그것을 싣는다(묶기에 쓰는 기록 그대로의 stack 은 싣지 않는다).
      Object.assign(
        { kind: f.kind, keys: f.keys, requests: f.requests },
        shownStacks(f),
        f.count === undefined ? {} : { count: f.count },
        CACHE_FINDING_TEXT[f.kind],
      ),
    ),
    ...fetchCausesOf(records, classes),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REACT_QUERY_HOW_TO_READ_EXTRA: readonly string[] = [
  'reactQuery.findings: invalidate-unloaded means the key shape matched but the specific query does not exist yet — a valid invalidation, nothing to fix. double-invalidate means overlapping invalidations where the second cancelled the first refetch; remove one of the two call sites in stacks (requests shows the cancelled request). count is the number of occurrences grouped at the same call site (for invalidate-* it is the number of keys, so keys shows a prefix; for double-invalidate it is the overlap count). stack (and each of stacks) is the call site of invalidateQueries: up to 3 app-code frames (library frames removed), first frame first, source-mapped like callers.',
  'reactQuery.fetchCauses explains why each React Query request was issued (cause: initial — first fetch, mount/enabled — observer mounted or enabled turned on while stale, key-change — observer queryKey changed, invalidate — invalidation, focus — window focus or reconnect, interval — polling). observer is the component that renders the useQuery call, evidence shows the staleTime and time since last update at that moment. When fix is present the same response was fetched again wastefully; follow the prescribed fix (e.g., increase staleTime).',
  `reactQuery.fetchCauses lists at most ${MAX_FETCH_CAUSES} groups (most fetches first); fetchCausesOmitted is how many more groups were left out by that limit.`,
];
