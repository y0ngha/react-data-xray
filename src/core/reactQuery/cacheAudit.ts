import { findRootFibers, walkFibers } from '../fiber/tree.js';
import { findDerivedOrigin } from '../inspect/derivedMatch.js';
import type { RequestClass } from '../requests/classify.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { RequestRecord } from '../requests/types.js';

/**
 * React Query 캐시키 설계 점검. react-query 를 import 하지 않고 객체 모양으로 알아본다(패키지에 의존하지 않기 위해).
 * - duplicate-cache: 같은 요청(메서드·URL·본문)의 데이터를 서로 다른 queryKey 로 캐시한다 → 키를 하나로 맞춘다
 * - key-missing-param: 같은 queryKey 로 서로 다른 요청을 가져왔다 → 쿼리 함수가 쓰는 값(파라미터)이 키에 빠졌다
 * - invalidate-miss: invalidateQueries 에 준 키와 맞는 쿼리가 이 화면에서 지금까지 없었다 → 무효화가 빗나간다
 * - stale-zero: staleTime 이 0 이라 화면을 옮길 때마다 같은 응답을 다시 받는다 → staleTime 을 늘린다
 *
 * 앞의 둘은 QueryCache 를 구독해 "쿼리 함수가 실제로 가져온" 성공만 기록한다(setQueryData·initialData 처럼 직접 넣은
 * 데이터는 요청이 아니다). 점검할 때 캐시를 훑기만 하면 그사이의 변경을 놓친다.
 */
export type CacheFindingKind = 'duplicate-cache' | 'key-missing-param' | 'invalidate-miss' | 'stale-zero';

export interface CacheFinding {
  kind: CacheFindingKind;
  /** 문제가 된 queryKey 들(JSON) */
  keys: string[];
  /** 관련 요청(메서드 URL) */
  requests: string[];
  /** invalidate-miss: invalidateQueries 를 부른 코드 위치 */
  stack?: string;
}

interface QueryLike {
  queryKey: unknown;
  queryHash: string;
  state: { data: unknown };
  options?: { staleTime?: unknown };
  observers?: Array<{ options?: { staleTime?: unknown; refetchInterval?: unknown } }>;
}

interface CacheEvent {
  type: string;
  query?: QueryLike;
  action?: { type?: string; manual?: boolean };
}

interface QueryCacheLike {
  getAll: () => QueryLike[];
  subscribe: (listener: (event: CacheEvent) => void) => () => void;
}

interface QueryClientLike {
  getQueryCache: () => QueryCacheLike;
  invalidateQueries: (...args: unknown[]) => unknown;
}

const isClient = (v: unknown): v is QueryClientLike => {
  const c = v as Partial<QueryClientLike> | null;
  return !!c && typeof c.getQueryCache === 'function' && typeof c.invalidateQueries === 'function';
};

const keyText = (key: unknown): string => {
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
};

// 고친 문제가 계속 남지 않게, 기록은 이만큼 지나면 버린다.
const HISTORY_MS = 120_000;
const MAX_EVENTS = 1000;
// 쿼리 성공 직전에 끝난 요청만 그 쿼리의 요청으로 본다(파생 매칭이 엉뚱한 요청을 고르지 않게).
const FETCH_WINDOW_MS = 5000;

interface Fetched {
  at: number;
  queryHash: string;
  queryKey: string;
  requestKey: string;
  request: string;
}

interface ClientHistory {
  fetched: Fetched[];
  /** 지금까지 만든 쿼리 키(무효화 미스 판정용) */
  keys: Map<string, unknown>;
  misses: Array<{ at: number; finding: CacheFinding }>;
}

const histories = new WeakMap<QueryClientLike, ClientHistory>();

const describeRequest = (r: RequestRecord): string => `${r.method} ${r.url}`;

/** 쿼리 함수가 가져온 데이터의 요청. 같은 참조가 아니면(structural sharing 이 복사) 필드 값으로 찾되, 방금 끝난 요청만 */
const fetchedRequest = (data: unknown, now: number): RequestRecord | undefined => {
  if (data === null || typeof data !== 'object') return undefined;
  const record = (getOrigin(data) ?? findDerivedOrigin(data))?.record;
  return record && now - (record.startedAt + record.durationMs) <= FETCH_WINDOW_MS ? record : undefined;
};

/** v5 는 invalidateQueries({ queryKey }), v4 는 invalidateQueries(queryKey) 도 받는다. */
const invalidatedKey = (args: unknown[]): unknown => {
  const first = args[0];
  if (Array.isArray(first)) return first;
  return (first as { queryKey?: unknown } | undefined)?.queryKey;
};

/** react-query 의 접두사 일치: 무효화 키의 각 요소가 쿼리 키의 앞부분과 같으면 맞는다. */
const matchesPrefix = (prefix: unknown, key: unknown): boolean =>
  Array.isArray(prefix) && Array.isArray(key) && prefix.length <= key.length && prefix.every((p, i) => keyText(p) === keyText(key[i]));

const recordFetch = (
  history: ClientHistory,
  q: QueryLike,
  record: RequestRecord | undefined = fetchedRequest(q.state.data, Date.now()),
): void => {
  const now = Date.now();
  if (!record) return;
  history.fetched.push({
    at: now,
    queryHash: q.queryHash,
    queryKey: keyText(q.queryKey),
    requestKey: requestKeyOf(record),
    request: describeRequest(record),
  });
  if (history.fetched.length > MAX_EVENTS) history.fetched.shift();
};

const recordInvalidate = (history: ClientHistory, args: unknown[]): void => {
  const key = invalidatedKey(args);
  if (key === undefined || [...history.keys.values()].some((k) => matchesPrefix(key, k))) return;
  history.misses.push({
    at: Date.now(),
    finding: { kind: 'invalidate-miss', keys: [keyText(key)], requests: [], stack: new Error().stack },
  });
  if (history.misses.length > MAX_EVENTS) history.misses.shift();
};

/** 처음 본 client 를 감시한다: 쿼리 성공을 기록하고, 무효화가 빗나가는지 본다. 원래 동작은 그대로 한다. */
const watch = (client: QueryClientLike): void => {
  if (histories.has(client)) return;
  const history: ClientHistory = { fetched: [], keys: new Map(), misses: [] };
  histories.set(client, history);
  const cache = client.getQueryCache();
  // 찾기 전에 가져온 데이터: 같은 참조로 출처가 확실한 것만 기록으로 채운다.
  cache.getAll().forEach((q) => {
    history.keys.set(keyText(q.queryKey), q.queryKey);
    const data = q.state.data;
    if (data !== null && typeof data === 'object') recordFetch(history, q, getOrigin(data)?.record);
  });
  cache.subscribe((event) => {
    try {
      if (!event.query) return;
      history.keys.set(keyText(event.query.queryKey), event.query.queryKey);
      // 직접 넣은 데이터(setQueryData 는 manual)는 요청이 아니다.
      if (event.type === 'updated' && event.action?.type === 'success' && !event.action.manual) recordFetch(history, event.query);
    } catch {
      // 점검 실패가 앱의 캐시 동작을 막으면 안 된다.
    }
  });
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = (...args: unknown[]) => {
    try {
      recordInvalidate(history, args);
    } catch {
      // 점검 실패가 앱의 무효화를 막으면 안 된다.
    }
    return original(...args);
  };
};

/** 지금 화면의 QueryClientProvider 에서 QueryClient 를 찾고 감시한다. 사라진 Provider 의 client 는 붙잡지 않는다. */
export const findQueryClients = (): QueryClientLike[] => {
  const clients = new Set<QueryClientLike>();
  findRootFibers().forEach((root) =>
    walkFibers(root.child, (f) => {
      const client = (f.memoizedProps as { client?: unknown } | null)?.client;
      if (isClient(client)) clients.add(client);
      return true;
    }),
  );
  clients.forEach(watch);
  return [...clients];
};

const uniq = <T>(list: readonly T[]): T[] => [...new Set(list)];

const groupFetched = (fetched: readonly Fetched[], keyOf: (f: Fetched) => string): Fetched[][] => {
  const groups = new Map<string, Fetched[]>();
  fetched.forEach((f) => {
    const list = groups.get(keyOf(f));
    if (list) list.push(f);
    else groups.set(keyOf(f), [f]);
  });
  return [...groups.values()];
};

/** 같은 키로 다른 요청을 가져왔거나, 같은 요청을 다른 키로 가져왔는지(최근 기록에서) */
const keyFindings = (fetched: readonly Fetched[]): CacheFinding[] => [
  ...groupFetched(fetched, (f) => f.requestKey)
    .filter((list) => new Set(list.map((f) => f.queryHash)).size > 1)
    .map((list): CacheFinding => ({ kind: 'duplicate-cache', keys: uniq(list.map((f) => f.queryKey)), requests: [list[0].request] })),
  ...groupFetched(fetched, (f) => f.queryHash)
    .filter((list) => new Set(list.map((f) => f.requestKey)).size > 1)
    .map((list): CacheFinding => ({ kind: 'key-missing-param', keys: [list[0].queryKey], requests: uniq(list.map((f) => f.request)) })),
];

/** 폴링(refetchInterval)이 아니고, 모든 관찰자의 staleTime 이 0 인 쿼리 */
const refetchesOnEveryVisit = (q: QueryLike): boolean =>
  !!q.observers?.length &&
  q.observers.every((o) => !o.options?.refetchInterval && (o.options?.staleTime ?? q.options?.staleTime ?? 0) === 0);

const staleFindings = (client: QueryClientLike, sameResponse: ReadonlySet<string>): CacheFinding[] =>
  client
    .getQueryCache()
    .getAll()
    .filter(refetchesOnEveryVisit)
    .flatMap((q): CacheFinding[] => {
      const data = q.state.data;
      const record = data !== null && typeof data === 'object' ? getOrigin(data)?.record : undefined;
      return record && sameResponse.has(requestKeyOf(record))
        ? [{ kind: 'stale-zero', keys: [keyText(q.queryKey)], requests: [describeRequest(record)] }]
        : [];
    });

/** 지금 점검한다. classOf 는 같은 응답 재요청 판정에 쓴다. */
export const auditQueryCache = (classOf: (r: RequestRecord) => RequestClass, records: readonly RequestRecord[]): CacheFinding[] => {
  const now = Date.now();
  const sameResponse = new Set(records.filter((r) => classOf(r) === 'same-response').map(requestKeyOf));
  const findings = findQueryClients().flatMap((client) => {
    const history = histories.get(client)!;
    history.fetched = history.fetched.filter((f) => now - f.at <= HISTORY_MS);
    history.misses = history.misses.filter((m) => now - m.at <= HISTORY_MS);
    return keyFindings(history.fetched).concat(
      staleFindings(client, sameResponse),
      history.misses.map((m) => m.finding),
    );
  });
  // 같은 종류·키·요청은 하나로 합친다(같은 키를 여러 번 무효화한 경우 등).
  return Array.from(new Map(findings.map((f) => [findingId(f), f])).values());
};

/** 점검 결과 하나를 가리키는 문자열(화면 key, 합치기) */
export const findingId = (f: CacheFinding): string => `${f.kind}|${f.keys.join(',')}|${f.requests.join(',')}`;

export const CACHE_FINDING_TEXT: Record<CacheFindingKind, { title: string; fix: string }> = {
  'duplicate-cache': {
    title: '같은 요청을 서로 다른 키로 캐시합니다',
    fix: '같은 데이터면 queryKey 를 하나로 맞추세요. 키가 다르면 캐시를 나눠 써서 같은 요청이 여러 번 나갑니다.',
  },
  'key-missing-param': {
    title: '같은 키로 서로 다른 요청을 가져왔습니다',
    fix: '쿼리 함수가 쓰는 값(URL 파라미터, 필터 등)을 queryKey 에 넣으세요. 빠지면 다른 조건의 데이터가 같은 캐시를 덮어씁니다.',
  },
  'invalidate-miss': {
    title: '무효화한 키와 맞는 쿼리가 없었습니다',
    fix: '이 화면에서 지금까지 만든 쿼리 중 이 키(접두사)와 맞는 것이 없습니다. queryKey 와 모양이 같은지 확인하세요. 다른 화면의 쿼리를 미리 무효화한 것이라면 무시해도 됩니다.',
  },
  'stale-zero': {
    title: 'staleTime 이 0 이라 같은 응답을 다시 받습니다',
    fix: '자주 바뀌지 않는 데이터면 staleTime 을 늘리세요(예: 30_000). 화면을 옮기거나 포커스가 돌아올 때마다 같은 요청이 나갑니다.',
  },
};
