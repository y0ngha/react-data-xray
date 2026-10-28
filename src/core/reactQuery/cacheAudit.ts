import { findRootFibers, walkFibers } from '../fiber/tree.js';
import { findDerivedOrigin, isIndexPending } from '../inspect/derivedMatch.js';
import { isQueuePending } from '../scheduler/idleQueue.js';
import type { RequestClass } from '../requests/classify.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { Origin, RequestRecord } from '../requests/types.js';

/**
 * React Query 캐시키 설계 점검. react-query 를 import 하지 않고 객체 모양으로 알아본다(패키지에 의존하지 않기 위해).
 * - duplicate-cache: 같은 요청(메서드·URL·본문)의 데이터를 서로 다른 queryKey 로 캐시한다 → 키를 하나로 맞춘다
 * - key-missing-param: 같은 queryKey 로 서로 다른 요청을 가져왔다 → 쿼리 함수가 쓰는 값(파라미터)이 키에 빠졌다
 * - invalidate-miss: invalidateQueries 에 준 키와 맞는 쿼리가 이 화면에서 지금까지 없었다 → 무효화가 빗나간다
 * - invalidate-unloaded: 무효화 키의 모양(앞 두 문자열)은 본 적 있지만 그 값의 쿼리는 아직 없다 → 정상(상속 범위 무효화 등), 한 줄로 묶어 회색으로 보인다
 * - double-invalidate: 짧은 시간 안에 같은 쿼리를 덮는 무효화를 두 번 불렀다 → 뒤가 앞의 재조회를 취소해 같은 요청이 두 번 나간다
 * - stale-zero: staleTime 이 0 이라 화면을 옮길 때마다 같은 응답을 다시 받는다 → staleTime 을 늘린다
 *
 * 앞의 둘은 QueryCache 를 구독해 "쿼리 함수가 실제로 가져온" 성공만 기록한다(setQueryData·initialData 처럼 직접 넣은
 * 데이터는 요청이 아니다). 점검할 때 캐시를 훑기만 하면 그사이의 변경을 놓친다.
 */
export type CacheFindingKind =
  | 'duplicate-cache'
  | 'key-missing-param'
  | 'invalidate-miss'
  | 'invalidate-unloaded'
  | 'double-invalidate'
  | 'stale-zero';

export interface CacheFinding {
  kind: CacheFindingKind;
  /** 문제가 된 queryKey 들(JSON) */
  keys: string[];
  /** 관련 요청(메서드 URL) */
  requests: string[];
  /** invalidate-miss: invalidateQueries 를 부른 코드 위치 */
  stack?: string;
  /** double-invalidate: 겹친 두 무효화의 호출 위치(앞, 뒤) */
  stacks?: string[];
  /** invalidate-*: 같은 호출 위치에서 묶인 무효화 키 수(keys 는 앞의 몇 개만 남긴다) */
  count?: number;
}

interface ObserverLike {
  options?: { staleTime?: unknown; refetchInterval?: unknown; enabled?: unknown };
}

interface QueryLike {
  queryKey: unknown;
  queryHash: string;
  state: { data: unknown; dataUpdatedAt?: number; isInvalidated?: boolean };
  options?: { staleTime?: unknown };
  observers?: ObserverLike[];
}

interface CacheEvent {
  type: string;
  query?: QueryLike;
  observer?: ObserverLike;
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
  /** 출처를 못 찾은 점검 횟수 */
  attempts?: number;
}

interface ClientHistory {
  pending: PendingFetch[];
  fetched: Fetched[];
  /** 지금까지 만든 쿼리 키(queryHash → queryKey, 무효화 미스 판정용) */
  keys: Map<string, unknown>;
  misses: Array<{ at: number; finding: CacheFinding }>;
  /** 직전 무효화(겹침 판정용, 짧은 시간만 남긴다) */
  recent: Array<{ at: number; key: unknown; stack?: string }>;
  /** 쿼리 성공 기록(재조회 원인 판정용). 같은 응답이면 structural sharing 이 앞 데이터를 그대로 써 출처 매칭 기록(fetched)에 남지 않아 따로 둔다. */
  successes: Array<{ at: number; queryHash: string; data: WeakRef<object> }>;
  /** 무효화 기록(재조회 원인 판정용). 맞는 쿼리가 있었는지와 무관하게 전부 남긴다. */
  invalidations: Array<{ at: number; key: unknown }>;
  /** fetch 를 일으킬 수 있던 관찰자 이벤트(마운트, enabled 켜짐). 원인 판정은 조회할 때 한다. */
  triggers: Array<{ at: number; seq: number; queryHash: string; kind: 'mount' | 'enabled' }>;
  /** fetch 시작 순간의 쿼리 상태(원인 판정의 근거) */
  fetchStarts: FetchStart[];
}

interface FetchStart {
  at: number;
  /** 이벤트 순서(같은 시각이어도 어느 fetch 가 그 관찰자 이벤트에 이어졌는지 가른다) */
  seq: number;
  queryHash: string;
  /** 앞선 성공이 있었나(없으면 첫 조회) */
  hadData: boolean;
  dataUpdatedAt: number;
  invalidated: boolean;
  staleTime?: number;
  interval: boolean;
}

const MAX_KEYS = 2000;
// 네트워크 출처가 없는 데이터를 영원히 다시 찾지 않게, 이만큼 못 찾으면 버린다.
const MAX_ATTEMPTS = 3;

// 관찰자의 직전 enabled(false → true 로 켜지는 순간을 알아보려고)
let eventSeq = 0;
const enabledOf = new WeakMap<object, boolean>();

const histories = new WeakMap<QueryClientLike, ClientHistory>();
// 지금까지 감시한 client(트리를 다시 걷지 않고 재조회 원인을 찾으려고). 사라진 client 는 붙잡지 않는다.
const watched: Array<WeakRef<QueryClientLike>> = [];
// 측정을 새로 시작한 시각. 그 전 기록은 점검에 쓰지 않는다(고치기 전 지적이 고친 뒤 보고서에 남지 않게).
let auditFrom = 0;

/** 측정을 새로 시작한다(window.__RDX__.reset) */
export const resetCacheAudit = (): void => {
  auditFrom = Date.now();
};

const describeRequest = (r: RequestRecord): string => `${r.method} ${r.url}`;

// 본문을 읽을 수 없는 요청(Request 객체, Blob 등)은 같은 요청인지 알 수 없어 키 점검에서 뺀다.
const comparable = (r: RequestRecord | undefined): RequestRecord | undefined => (r?.bodyUnreadable ? undefined : r);

/** 같은 참조로 확실한 데이터의 요청 */
const exactRequest = (data: unknown): RequestRecord | undefined =>
  data !== null && typeof data === 'object' ? comparable(getOrigin(data)?.record) : undefined;

// 배열의 출처를 항목으로 찾을 때 볼 항목 수
const MAX_ITEMS_TO_MATCH = 5;

/**
 * 캐시 데이터의 출처. structural sharing 은 이전 데이터와 다르면 배열·객체를 새로 복사한다. 객체는 필드 값(파생)으로 찾지만
 * 배열은 파생 매칭이 없어, 목록 응답([...])은 두 번째 조회부터 출처를 잃었다. 배열이면 항목의 출처에서 요청을 찾는다.
 */
const originOfData = (data: object): Origin | undefined => {
  const direct = getOrigin(data) ?? findDerivedOrigin(data) ?? undefined;
  if (direct || !Array.isArray(data)) return direct;
  for (const item of data.slice(0, MAX_ITEMS_TO_MATCH)) {
    if (item === null || typeof item !== 'object') continue;
    const origin = getOrigin(item) ?? findDerivedOrigin(item);
    if (origin) return origin;
  }
  return undefined;
};

/** 쿼리 함수가 가져온 데이터의 요청. 같은 참조가 아니면(structural sharing 이 복사) 필드 값으로 찾되, 성공 직전에 끝난 요청만 */
const fetchedRequest = (data: object, at: number): RequestRecord | undefined => {
  const record = comparable(originOfData(data)?.record);
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

/**
 * 미뤄 둔 성공 이벤트의 출처를 찾는다. 큐를 비우지 않는다(주기적으로 불리므로): 등록이 끝난 것만 쓰고,
 * 큐에 일이 남은 동안은 못 찾은 이벤트를 다음 점검으로 넘긴다.
 */
const resolvePending = (history: ClientHistory): void => {
  if (history.pending.length === 0) return;
  const unresolved: PendingFetch[] = [];
  history.pending.forEach((p) => {
    const value = p.data.deref();
    const record = value && fetchedRequest(value, p.at);
    if (record) pushBounded(history.fetched, toFetched(p.at, p.queryHash, p.queryKey, record));
    // 색인이 아직 도는 동안의 실패는 세지 않는다(색인 뒤에야 찾는 파생 출처).
    else if (value && (p.attempts = (p.attempts ?? 0) + (isIndexPending() ? 0 : 1)) < MAX_ATTEMPTS) unresolved.push(p);
  });
  history.pending = isQueuePending() ? unresolved : [];
};

/** 앱에서 invalidateQueries 를 부른 위치. rdx 가 감싼 invalidateQueries 와 그 안쪽 프레임은 뺀다(앱 코드가 첫 줄에 오게). */
const callerStack = (): string | undefined => {
  const lines = (new Error().stack ?? '').split('\n').map((line) => line.trim());
  const wrapper = lines.findIndex((line) => line.includes('invalidateQueries'));
  return (
    lines
      .slice(wrapper + 1)
      .filter((line) => line && line !== 'Error')
      .join('\n') || undefined
  );
};

// 키 모양: 앞 두 요소가 모두 문자열이면 그 둘(예: ['scopedMember','list']). 한 요소뿐인 키는 모양으로 보지 않는다.
const SHAPE_LEN = 2;
const shapeOf = (key: unknown): string | undefined =>
  Array.isArray(key) && key.length >= SHAPE_LEN && key.slice(0, SHAPE_LEN).every((k) => typeof k === 'string')
    ? keyText(key.slice(0, SHAPE_LEN))
    : undefined;

// 이 시간 안에 같은 쿼리를 덮는 무효화가 또 오면 겹친 것으로 본다(뒤의 무효화가 앞의 재조회를 취소한다).
const OVERLAP_MS = 50;

/** 앞 무효화와 같은 쿼리를 함께 덮으면 double-invalidate 로 남긴다 */
const recordOverlap = (history: ClientHistory, key: unknown, seen: unknown[], at: number, stack: string | undefined): void => {
  history.recent = history.recent.filter((r) => at - r.at <= OVERLAP_MS);
  const first = history.recent.find((r) => seen.some((k) => partialMatch(r.key, k) && partialMatch(key, k)));
  if (first)
    pushBounded(history.misses, {
      at,
      finding: {
        kind: 'double-invalidate',
        keys: [keyText(first.key), keyText(key)],
        requests: [],
        stack,
        stacks: [first.stack ?? '', stack ?? ''],
      },
    });
  history.recent.push({ at, key, stack });
};

const recordInvalidate = (history: ClientHistory, args: unknown[]): void => {
  const key = invalidatedKey(args);
  if (key !== undefined) pushBounded(history.invalidations, { at: Date.now(), key });
  const seen = [...history.keys.values()];
  if (key !== undefined) recordOverlap(history, key, seen, Date.now(), callerStack());
  if (key === undefined || seen.some((k) => partialMatch(key, k))) return;
  const shape = shapeOf(key);
  const kind = shape !== undefined && seen.some((k) => shapeOf(k) === shape) ? 'invalidate-unloaded' : 'invalidate-miss';
  pushBounded(history.misses, { at: Date.now(), finding: { kind, keys: [keyText(key)], requests: [], stack: callerStack() } });
};

const SAMPLE_KEYS = 3;
/** 같은 종류·같은 호출 위치(스택 첫 줄)의 무효화는 한 줄로 묶는다(키는 앞 몇 개만, 수는 count) */
const foldInvalidations = (findings: readonly CacheFinding[]): CacheFinding[] => {
  const groups = new Map<string, CacheFinding[]>();
  const out: CacheFinding[] = [];
  findings.forEach((f) => {
    const at = f.stack?.split('\n')[0];
    if (!f.kind.startsWith('invalidate-') || !at) return void out.push(f);
    const id = `${f.kind}|${at}`;
    const list = groups.get(id);
    if (list) list.push(f);
    else {
      groups.set(id, [f]);
      out.push(f);
    }
  });
  return out.map((f) => {
    const list = groups.get(`${f.kind}|${f.stack?.split('\n')[0]}`);
    return list && list.length > 1
      ? Object.assign({}, f, { keys: list.slice(0, SAMPLE_KEYS).map((g) => g.keys[0]), count: list.length })
      : f;
  });
};

// 관찰자 이벤트와 fetch 시작은 이 시간 안에 이어진다(둘 다 같은 호출 안에서 일어난다).
const TRIGGER_WINDOW_MS = 100;

/** fetch 원인의 근거만 담는다(시각·상태 몇 개). 판정과 요청 연결은 조회할 때 한다. */
const noteFetchEvent = (history: ClientHistory, event: CacheEvent, q: QueryLike): void => {
  const at = Date.now();
  const o = event.observer;
  if (o && (event.type === 'observerAdded' || event.type === 'observerOptionsUpdated')) {
    const enabled = o.options?.enabled !== false;
    const before = enabledOf.get(o);
    enabledOf.set(o, enabled);
    const kind = event.type === 'observerAdded' ? 'mount' : before === false ? 'enabled' : undefined;
    if (kind && enabled) pushBounded(history.triggers, { at, seq: ++eventSeq, queryHash: q.queryHash, kind });
  } else if (event.type === 'updated' && event.action?.type === 'fetch') {
    pushBounded(history.fetchStarts, {
      at,
      seq: ++eventSeq,
      queryHash: q.queryHash,
      hadData: (q.state.dataUpdatedAt ?? 0) > 0,
      dataUpdatedAt: q.state.dataUpdatedAt ?? 0,
      invalidated: !!q.state.isInvalidated,
      staleTime: staleTimeOf(q),
      interval: !!q.observers?.some((x) => x.options?.refetchInterval),
    });
  }
};

/** 처음 본 client 를 감시한다: 쿼리 성공을 기록하고, 무효화가 빗나가는지 본다. 원래 동작은 그대로 한다. */
const watch = (client: QueryClientLike): void => {
  if (histories.has(client)) return;
  const history: ClientHistory = {
    pending: [],
    fetched: [],
    keys: new Map(),
    misses: [],
    recent: [],
    successes: [],
    invalidations: [],
    triggers: [],
    fetchStarts: [],
  };
  histories.set(client, history);
  watched.push(new WeakRef(client));
  const cache = client.getQueryCache();
  // 찾기 전에 가져온 데이터: 같은 참조로 출처가 확실한 것만 기록으로 채운다(파생 매칭은 쓰지 않는다).
  const now = Date.now();
  cache.getAll().forEach((q) => {
    rememberKey(history, q);
    q.observers?.forEach((o) => enabledOf.set(o, o.options?.enabled !== false));
    const record = exactRequest(q.state.data);
    if (record) pushBounded(history.fetched, toFetched(now, q.queryHash, q.queryKey, record));
  });
  cache.subscribe((event) => {
    try {
      const q = event.query;
      if (!q) return;
      if (event.type === 'added') rememberKey(history, q);
      noteFetchEvent(history, event, q);
      // 직접 넣은 데이터(setQueryData 는 manual)는 요청이 아니다. 출처는 점검할 때 찾는다(dispatch 안에서 일을 줄인다).
      const data = q.state.data;
      if (
        event.type === 'updated' &&
        event.action?.type === 'success' &&
        !event.action.manual &&
        data !== null &&
        typeof data === 'object'
      ) {
        const at = Date.now();
        pushBounded(history.pending, { at, queryHash: q.queryHash, queryKey: q.queryKey, data: new WeakRef(data) });
        pushBounded(history.successes, { at, queryHash: q.queryHash, data: new WeakRef(data) });
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
    const record = exactRequest(q.state.data);
    return record ? [toFetched(now, q.queryHash, q.queryKey, record)] : [];
  });

const staleFindings = (queries: readonly QueryLike[], sameResponse: ReadonlySet<string>): CacheFinding[] =>
  queries.filter(refetchesOnEveryVisit).flatMap((q): CacheFinding[] => {
    const data = q.state.data;
    // queryFn 이 응답을 가공해 돌려줘도 찾도록 필드 값까지 본다.
    const record = data !== null && typeof data === 'object' ? originOfData(data)?.record : undefined;
    return record && sameResponse.has(requestKeyOf(record))
      ? [{ kind: 'stale-zero', keys: [keyText(q.queryKey)], requests: [describeRequest(record)] }]
      : [];
  });

// 뒤 무효화가 취소한 요청: 겹친 시각 부근에 에러로 끝난(취소) 요청
const CANCEL_SLACK_MS = 1000;
const cancelledBy = (at: number, records: readonly RequestRecord[]): RequestRecord[] =>
  records.filter((r) => r.error && r.startedAt <= at && r.startedAt + r.durationMs >= at - CANCEL_SLACK_MS);

/** 취소된 요청이 있으면 requests 에 원인과 함께 남긴다 */
const withCancelled = (m: { at: number; finding: CacheFinding }, records: readonly RequestRecord[]): CacheFinding =>
  Object.assign({}, m.finding, { requests: cancelledBy(m.at, records).map((r) => `${describeRequest(r)} (무효화가 겹쳐 취소됨)`) });

/** 지금 점검한다. classOf 는 같은 응답 재요청 판정에 쓴다. */
export const auditQueryCache = (
  classOf: (r: RequestRecord) => RequestClass,
  records: readonly RequestRecord[],
  clients: readonly QueryClientLike[] = findQueryClients(),
): CacheFinding[] => {
  const now = Date.now();
  // 2초 안에 다시 받으면 '중복'으로 나뉘지만, 본문이 같았다면 staleTime 0 의 재요청과 같은 일이다(빠른 재마운트·화면 전환).
  const sameResponse = new Set(
    records
      .filter((r) => classOf(r) === 'same-response' || (classOf(r) === 'duplicate' && r.sameResponseAs !== undefined))
      .map(requestKeyOf),
  );
  const fetched: Fetched[] = [];
  const others: CacheFinding[] = [];
  // 여러 QueryClient 를 쓰면 client 사이의 중복 캐시도 보도록 함께 판정한다.
  clients.forEach((client) => {
    const history = histories.get(client)!;
    resolvePending(history);
    const from = Math.max(now - HISTORY_MS, auditFrom);
    history.fetched = history.fetched.filter((f) => f.at >= from);
    history.misses = history.misses.filter((m) => m.at >= from);
    history.successes = history.successes.filter((s) => s.at >= from);
    history.triggers = history.triggers.filter((t) => t.at >= from);
    history.fetchStarts = history.fetchStarts.filter((f) => f.at >= from);
    const queries = client.getQueryCache().getAll();
    fetched.push(...history.fetched, ...currentFetched(queries, now));
    others.push(
      ...staleFindings(queries, sameResponse),
      ...history.misses.map((m) => (m.finding.kind === 'double-invalidate' ? withCancelled(m, records) : m.finding)),
    );
  });
  const findings = keyFindings(fetched).concat(others);
  // 같은 종류·키·요청은 하나로 합친다(같은 키를 여러 번 무효화한 경우 등).
  return foldInvalidations(Array.from(new Map(findings.map((f) => [findingId(f), f])).values()));
};

/** 쿼리 재조회 원인. 같은 응답을 다시 받았을 때 낭비인지 의도인지 가르는 근거다. */
export type RefetchReason = 'stale-elapsed' | 'stale-zero' | 'after-invalidate';

// 무효화 호출이 요청을 보내기까지 걸리는 시간의 상한
const INVALIDATE_TO_REQUEST_MS = 1000;
// 요청이 끝난 뒤 쿼리 성공이 기록되기까지의 여유
const SUCCESS_SLACK_MS = 200;

const staleTimeOf = (q: QueryLike): number | undefined => {
  const st = q.observers?.find((o) => typeof o.options?.staleTime === 'number')?.options?.staleTime ?? q.options?.staleTime;
  return typeof st === 'number' ? st : undefined;
};

/** 이 요청이 끝난 직후의 쿼리 성공 중 데이터 출처가 이 요청과 같은 요청인 것(어느 쿼리의 요청인지) */
const successOf = (record: RequestRecord): { client: QueryClientLike; history: ClientHistory; at: number } | undefined => {
  for (const ref of watched) {
    const client = ref.deref();
    const history = client && histories.get(client);
    if (!client || !history) continue;
    resolvePending(history);
    const end = record.startedAt + record.durationMs;
    const at = history.successes.findIndex((s) => {
      const data = s.data.deref();
      const origin = data && originOfData(data)?.record;
      return s.at >= record.startedAt && s.at <= end + SUCCESS_SLACK_MS && !!origin && requestKeyOf(origin) === requestKeyOf(record);
    });
    if (at >= 0) return { client, history, at };
  }
  return undefined;
};

/**
 * 이 요청이 React Query 쿼리의 재조회라면 그 원인. 앞선 성공(dataUpdatedAt)과 비교해 판정한다.
 * - after-invalidate: 앞선 성공 뒤에 이 쿼리를 덮는 무효화가 직전에 있었다
 * - stale-zero: 폴링이 아니고 모든 관찰자의 staleTime 이 0 이다(고칠 대상)
 * - stale-elapsed: staleTime(>0)이 지난 뒤에 다시 받았다
 * 쿼리 성공 기록(2분)에 앞선 성공이 없으면(첫 요청, 오래된 요청) 알 수 없다. 사용자 조회·보고서에서 부른다.
 */
export const refetchReason = (record: RequestRecord): RefetchReason | undefined => {
  const found = successOf(record);
  if (!found) return undefined;
  const { client, history, at } = found;
  const { queryHash } = history.successes[at];
  const prev = history.successes
    .slice(0, at)
    .reverse()
    .find((f) => f.queryHash === queryHash);
  if (!prev) return undefined;
  const key = history.keys.get(queryHash);
  if (
    history.invalidations.some(
      (i) =>
        i.at >= prev.at && i.at <= record.startedAt + 5 && record.startedAt - i.at <= INVALIDATE_TO_REQUEST_MS && partialMatch(i.key, key),
    )
  )
    return 'after-invalidate';
  const q = client
    .getQueryCache()
    .getAll()
    .find((x) => x.queryHash === queryHash);
  if (!q) return undefined;
  if (refetchesOnEveryVisit(q)) return 'stale-zero';
  const staleTime = staleTimeOf(q);
  return staleTime !== undefined && staleTime > 0 && record.startedAt - prev.at >= staleTime ? 'stale-elapsed' : undefined;
};

/** fetch 를 일으킨 원인: 마운트, enabled 켜짐, 무효화, 포커스·재연결, refetchInterval, 첫 조회. 수동 refetch() 는 직접 신호가 없어 맞추지 못하면 원인 없음(undefined)이다. */
export type FetchCause = 'mount' | 'enabled' | 'invalidate' | 'focus' | 'interval' | 'initial';

export interface FetchCauseDetail {
  cause: FetchCause;
  queryKey: string;
  /** fetch 시작 순간의 staleTime(ms) */
  staleTime?: number;
  /** 마지막 갱신(dataUpdatedAt)으로부터 fetch 까지 지난 시간(ms). 첫 조회면 없다. */
  ageMs?: number;
  invalidated: boolean;
  /** 지금 캐시 데이터의 요청(같은 응답이면 첫 요청). 관찰자 컴포넌트를 찾는 데 쓴다. */
  dataRecord?: RequestRecord;
}

/**
 * 이 요청을 보낸 쿼리 fetch 의 원인과 근거. 판정 순서: 첫 조회 > 관찰자 이벤트(마운트·enabled 켜짐) 직후 >
 * 포커스·재연결 > 무효화 표시 > refetchInterval > 그 밖은 모른다(수동 호출의 직접 신호가 없다).
 * 쿼리 성공 기록(2분)에 없는 요청(실패, 취소, 오래됨)은 알 수 없다. 사용자 조회·보고서에서 부른다.
 */
export const fetchCauseDetail = (record: RequestRecord): FetchCauseDetail | undefined => {
  const found = successOf(record);
  if (!found) return undefined;
  const { client, history } = found;
  const { queryHash } = history.successes[found.at];
  const starts = history.fetchStarts.filter((f) => f.queryHash === queryHash);
  const fetch = [...starts].reverse().find((f) => f.at <= record.startedAt + 5 && record.startedAt - f.at <= INVALIDATE_TO_REQUEST_MS);
  if (!fetch) return undefined;
  // 앞 fetch 에 쓰인 관찰자 이벤트는 이 fetch 의 원인이 아니다
  const prevSeq = [...starts].reverse().find((f) => f.seq < fetch.seq)?.seq ?? 0;
  const trigger = [...history.triggers]
    .reverse()
    .find((t) => t.queryHash === queryHash && t.seq > prevSeq && t.seq < fetch.seq && fetch.at - t.at <= TRIGGER_WINDOW_MS);
  const cause: FetchCause | undefined = !fetch.hadData
    ? 'initial'
    : trigger
      ? trigger.kind
      : record.trigger
        ? 'focus'
        : fetch.invalidated
          ? 'invalidate'
          : fetch.interval
            ? 'interval'
            : undefined;
  if (!cause) return undefined;
  const data = client
    .getQueryCache()
    .getAll()
    .find((x) => x.queryHash === queryHash)?.state.data;
  const dataRecord = data !== null && typeof data === 'object' ? getOrigin(data)?.record : undefined;
  return {
    cause,
    queryKey: keyText(history.keys.get(queryHash)),
    ...(fetch.staleTime !== undefined && { staleTime: fetch.staleTime }),
    ...(fetch.hadData && { ageMs: fetch.at - fetch.dataUpdatedAt }),
    invalidated: fetch.invalidated,
    ...(dataRecord && { dataRecord }),
  };
};

export const fetchCause = (record: RequestRecord): FetchCause | undefined => fetchCauseDetail(record)?.cause;

/** 겹친 무효화(double-invalidate)가 취소한 요청이면 두 무효화의 호출 위치(앞, 뒤). 요청 상세에 원인을 보이려고 쓴다. */
export const overlapCancelOf = (record: RequestRecord): string[] | undefined => {
  for (const ref of watched) {
    const client = ref.deref();
    const history = client && histories.get(client);
    const m = history?.misses.find(
      (x) => x.at >= auditFrom && x.finding.kind === 'double-invalidate' && cancelledBy(x.at, [record]).length > 0,
    );
    if (m?.finding.stacks) return m.finding.stacks;
  }
  return undefined;
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
  'invalidate-unloaded': {
    title: '아직 불러오지 않은 키를 무효화했습니다',
    fix: '같은 모양(앞 두 요소)의 쿼리는 있었고 이 값의 쿼리만 아직 없습니다. 상속 범위 무효화 같은 정상 동작이라 고칠 것은 없습니다.',
  },
  'double-invalidate': {
    title: '같은 쿼리를 겹쳐 무효화했습니다',
    fix: '넓은 무효화가 좁은 무효화를 덮습니다. 한쪽만 남기세요. 뒤의 무효화가 앞의 재조회를 취소하고 다시 받아 같은 요청이 두 번 나갑니다.',
  },
  'stale-zero': {
    title: 'staleTime 이 0 이라 같은 응답을 다시 받습니다',
    fix: '자주 바뀌지 않는 데이터면 staleTime 을 늘리세요(예: 30_000). 화면을 옮기거나 포커스가 돌아올 때마다 같은 요청이 나갑니다.',
  },
};
