import { findRootFibers, walkFibers } from '../fiber/tree.js';
import { findDerivedOrigin, flushIndex } from '../inspect/derivedMatch.js';
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

/** 성공 이벤트에서 남긴 것. 출처 매칭은 점검할 때 한다(앱의 dispatch 안에서 색인을 조회하지 않게). */
interface PendingFetch {
  at: number;
  queryHash: string;
  queryKey: unknown;
  /** 데이터를 붙잡지 않는다(큰 응답이 2분 동안 남지 않게) */
  data: WeakRef<object>;
}

interface ClientHistory {
  pending: PendingFetch[];
  fetched: Fetched[];
  /** 지금까지 만든 쿼리 키(queryHash → queryKey, 무효화 미스 판정용) */
  keys: Map<string, unknown>;
  misses: Array<{ at: number; finding: CacheFinding }>;
}

const MAX_KEYS = 2000;

const histories = new WeakMap<QueryClientLike, ClientHistory>();

const describeRequest = (r: RequestRecord): string => `${r.method} ${r.url}`;

/** 쿼리 함수가 가져온 데이터의 요청. 같은 참조가 아니면(structural sharing 이 복사) 필드 값으로 찾되, 성공 직전에 끝난 요청만 */
const fetchedRequest = (data: object, at: number): RequestRecord | undefined => {
  const record = (getOrigin(data) ?? findDerivedOrigin(data))?.record;
  const finished = record ? record.startedAt + record.durationMs : -Infinity;
  return record && finished <= at && at - finished <= FETCH_WINDOW_MS ? record : undefined;
};

/** v5 는 invalidateQueries({ queryKey }), v4 는 invalidateQueries(queryKey) 도 받는다. */
const invalidatedKey = (args: unknown[]): unknown => {
  const first = args[0];
  if (Array.isArray(first)) return first;
  return (first as { queryKey?: unknown } | undefined)?.queryKey;
};

/**
 * react-query 의 partialMatchKey 와 같은 규칙: 무효화 키가 쿼리 키의 앞부분이면 맞고, 객체 요소는 무효화 쪽에 있는 필드만
 * 같으면 맞는다(키 순서는 보지 않는다). 배열도 객체처럼 첨자별로 비교하므로 짧은 접두사가 맞는다.
 */
const partialMatch = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  return Object.keys(a).every((k) => partialMatch((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

const pushBounded = <T>(list: T[], item: T): void => {
  list.push(item);
  if (list.length > MAX_EVENTS) list.shift();
};

const toFetched = (at: number, queryHash: string, queryKey: unknown, record: RequestRecord): Fetched => ({
  at,
  queryHash,
  queryKey: keyText(queryKey),
  requestKey: requestKeyOf(record),
  request: describeRequest(record),
});

const rememberKey = (history: ClientHistory, q: QueryLike): void => {
  history.keys.delete(q.queryHash);
  history.keys.set(q.queryHash, q.queryKey);
  if (history.keys.size > MAX_KEYS) history.keys.delete(history.keys.keys().next().value as string);
};

/** 미뤄 둔 성공 이벤트의 출처를 찾는다. 색인을 먼저 마쳐 방금 받은 응답이 빠지지 않게 한다. */
const resolvePending = (history: ClientHistory): void => {
  if (history.pending.length === 0) return;
  flushIndex();
  history.pending.forEach(({ at, queryHash, queryKey, data }) => {
    const value = data.deref();
    const record = value && fetchedRequest(value, at);
    if (record) pushBounded(history.fetched, toFetched(at, queryHash, queryKey, record));
  });
  history.pending = [];
};

const recordInvalidate = (history: ClientHistory, args: unknown[]): void => {
  const key = invalidatedKey(args);
  if (key === undefined || [...history.keys.values()].some((k) => partialMatch(key, k))) return;
  pushBounded(history.misses, {
    at: Date.now(),
    finding: { kind: 'invalidate-miss', keys: [keyText(key)], requests: [], stack: new Error().stack },
  });
};

/** 처음 본 client 를 감시한다: 쿼리 성공을 기록하고, 무효화가 빗나가는지 본다. 원래 동작은 그대로 한다. */
const watch = (client: QueryClientLike): void => {
  if (histories.has(client)) return;
  const history: ClientHistory = { pending: [], fetched: [], keys: new Map(), misses: [] };
  histories.set(client, history);
  const cache = client.getQueryCache();
  // 찾기 전에 가져온 데이터: 같은 참조로 출처가 확실한 것만 기록으로 채운다(파생 매칭은 쓰지 않는다).
  const now = Date.now();
  cache.getAll().forEach((q) => {
    rememberKey(history, q);
    const data = q.state.data;
    const record = data !== null && typeof data === 'object' ? getOrigin(data)?.record : undefined;
    if (record) pushBounded(history.fetched, toFetched(now, q.queryHash, q.queryKey, record));
  });
  cache.subscribe((event) => {
    try {
      const q = event.query;
      if (!q) return;
      if (event.type === 'added') rememberKey(history, q);
      // 직접 넣은 데이터(setQueryData 는 manual)는 요청이 아니다. 출처는 점검할 때 찾는다(dispatch 안에서 일을 줄인다).
      const data = q.state.data;
      if (
        event.type === 'updated' &&
        event.action?.type === 'success' &&
        !event.action.manual &&
        data !== null &&
        typeof data === 'object'
      ) {
        pushBounded(history.pending, { at: Date.now(), queryHash: q.queryHash, queryKey: q.queryKey, data: new WeakRef(data) });
      }
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

/** 지금 캐시의 데이터 출처. 데이터가 바뀌지 않아 기록(2분)이 지난 중복 캐시도 찾게 같은 참조인 것을 더한다. */
const currentFetched = (queries: readonly QueryLike[], now: number): Fetched[] =>
  queries.flatMap((q) => {
    const data = q.state.data;
    const record = data !== null && typeof data === 'object' ? getOrigin(data)?.record : undefined;
    return record ? [toFetched(now, q.queryHash, q.queryKey, record)] : [];
  });

const staleFindings = (queries: readonly QueryLike[], sameResponse: ReadonlySet<string>): CacheFinding[] =>
  queries.filter(refetchesOnEveryVisit).flatMap((q): CacheFinding[] => {
    const data = q.state.data;
    // queryFn 이 응답을 가공해 돌려줘도 찾도록 필드 값까지 본다.
    const record = data !== null && typeof data === 'object' ? (getOrigin(data) ?? findDerivedOrigin(data))?.record : undefined;
    return record && sameResponse.has(requestKeyOf(record))
      ? [{ kind: 'stale-zero', keys: [keyText(q.queryKey)], requests: [describeRequest(record)] }]
      : [];
  });

/** 지금 점검한다. classOf 는 같은 응답 재요청 판정에 쓴다. */
export const auditQueryCache = (classOf: (r: RequestRecord) => RequestClass, records: readonly RequestRecord[]): CacheFinding[] => {
  const now = Date.now();
  const sameResponse = new Set(records.filter((r) => classOf(r) === 'same-response').map(requestKeyOf));
  const fetched: Fetched[] = [];
  const others: CacheFinding[] = [];
  // 여러 QueryClient 를 쓰면 client 사이의 중복 캐시도 보도록 함께 판정한다.
  findQueryClients().forEach((client) => {
    const history = histories.get(client)!;
    resolvePending(history);
    history.fetched = history.fetched.filter((f) => now - f.at <= HISTORY_MS);
    history.misses = history.misses.filter((m) => now - m.at <= HISTORY_MS);
    const queries = client.getQueryCache().getAll();
    fetched.push(...history.fetched, ...currentFetched(queries, now));
    others.push(...staleFindings(queries, sameResponse), ...history.misses.map((m) => m.finding));
  });
  const findings = keyFindings(fetched).concat(others);
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
