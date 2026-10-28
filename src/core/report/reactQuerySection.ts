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
    fetchCauses: fetchCausesOf(records, classes),
  };
};

// 새 howToRead 줄은 여기에 더한다.
export const REACT_QUERY_HOW_TO_READ_EXTRA: readonly string[] = [
  'reactQuery.findings 의 invalidate-unloaded 는 키 모양은 맞고 값의 쿼리만 아직 없는 정상 무효화라 고칠 것이 없다. double-invalidate 는 같은 쿼리를 겹쳐 무효화해 뒤가 앞의 재조회를 취소한 것이라 stacks 의 두 호출 위치 중 한쪽을 지운다(requests 는 취소된 요청). count 는 같은 호출 위치에서 묶인 수(invalidate-* 는 키 수라 keys 는 앞 몇 개, double-invalidate 는 겹친 횟수)다.',
  'reactQuery.fetchCauses 는 React Query 요청이 왜 나갔는지다(cause: initial 첫 조회, mount·enabled 관찰자가 마운트되거나 enabled 가 켜져 stale 이라 받음, key-change 관찰자의 queryKey 가 바뀜, invalidate 무효화, focus 포커스·재연결, interval). observer 는 useQuery 를 그린 컴포넌트, evidence 는 그 순간의 staleTime·마지막 갱신 뒤 시간이다. fix 가 있으면 같은 응답을 낭비로 다시 받은 것이니 그 처방(staleTime 등)을 따른다.',
];
