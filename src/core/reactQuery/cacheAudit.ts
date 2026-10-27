import { findRootFibers, walkFibers } from '../fiber/tree.js';
import type { RequestClass } from '../requests/classify.js';
import { findDerivedOrigin } from '../inspect/derivedMatch.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { RequestRecord } from '../requests/types.js';

/**
 * React Query 캐시키 설계 점검. react-query 를 import 하지 않고 객체 모양으로 알아본다(패키지에 의존하지 않기 위해).
 * - duplicate-cache: 같은 요청(메서드·URL·본문)의 데이터를 서로 다른 queryKey 로 캐시한다 → 키를 하나로 맞춘다
 * - key-missing-param: 같은 queryKey 에 서로 다른 요청의 데이터가 들어왔다 → 쿼리 함수가 쓰는 값(파라미터)이 키에 빠졌다
 * - invalidate-miss: invalidateQueries 에 준 키와 맞는 쿼리가 없다 → 무효화가 빗나간다
 * - stale-zero: staleTime 이 0 이라 화면을 옮길 때마다 같은 응답을 다시 받는다 → staleTime 을 늘린다
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
  observers?: Array<{ options?: { staleTime?: unknown } }>;
}

interface QueryClientLike {
  getQueryCache: () => { getAll: () => QueryLike[]; findAll: (filters: { queryKey?: unknown }) => QueryLike[] };
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

const patched = new WeakSet<QueryClientLike>();
// queryHash → 지금까지 그 키에 들어온 요청 키들. 기록 수만큼만 남긴다.
const MAX_HISTORY = 500;
const requestsByKey = new Map<string, Set<string>>();
const invalidateMisses: CacheFinding[] = [];
const MAX_MISSES = 50;

/** v5 는 invalidateQueries({ queryKey }), v4 는 invalidateQueries(queryKey) 도 받는다. */
const invalidatedKey = (args: unknown[]): unknown => {
  const first = args[0];
  if (Array.isArray(first)) return first;
  return (first as { queryKey?: unknown } | undefined)?.queryKey;
};

/** 무효화가 빗나가는지 보려고 invalidateQueries 를 한 번만 감싼다. 원래 동작은 그대로 한다. */
const watchInvalidations = (client: QueryClientLike): void => {
  if (patched.has(client)) return;
  patched.add(client);
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = (...args: unknown[]) => {
    try {
      const key = invalidatedKey(args);
      if (key !== undefined && client.getQueryCache().findAll({ queryKey: key }).length === 0) {
        invalidateMisses.push({ kind: 'invalidate-miss', keys: [keyText(key)], requests: [], stack: new Error().stack });
        if (invalidateMisses.length > MAX_MISSES) invalidateMisses.shift();
      }
    } catch {
      // 점검 실패가 앱의 무효화를 막으면 안 된다.
    }
    return original(...args);
  };
};

/** 지금 화면의 QueryClientProvider 에서 QueryClient 를 찾고 무효화를 감시한다. 사라진 Provider 의 client 는 붙잡지 않는다. */
export const findQueryClients = (): QueryClientLike[] => {
  const clients = new Set<QueryClientLike>();
  findRootFibers().forEach((root) =>
    walkFibers(root.child, (f) => {
      const client = (f.memoizedProps as { client?: unknown } | null)?.client;
      if (isClient(client)) clients.add(client);
      return true;
    }),
  );
  clients.forEach(watchInvalidations);
  return [...clients];
};

const staleTimeOf = (q: QueryLike): unknown => q.observers?.[0]?.options?.staleTime ?? q.options?.staleTime ?? 0;

const rememberRequest = (hash: string, request: string): Set<string> => {
  const seen = requestsByKey.get(hash) ?? new Set<string>();
  seen.add(request);
  requestsByKey.delete(hash);
  requestsByKey.set(hash, seen);
  if (requestsByKey.size > MAX_HISTORY) requestsByKey.delete(requestsByKey.keys().next().value as string);
  return seen;
};

const describeRequest = (r: RequestRecord): string => `${r.method} ${r.url}`;

/** 지금 캐시를 점검한다. classOf 는 같은 응답 재요청 판정에 쓴다. */
export const auditQueryCache = (classOf: (r: RequestRecord) => RequestClass, records: readonly RequestRecord[]): CacheFinding[] => {
  const findings: CacheFinding[] = [];
  const keysByRequest = new Map<string, { record: RequestRecord; keys: Set<string> }>();
  findQueryClients().forEach((client) =>
    client
      .getQueryCache()
      .getAll()
      .forEach((q) => {
        const data = q.state.data;
        // 두 번째 응답부터는 structural sharing 이 바뀐 부분을 새 객체로 복사하므로, 같은 참조가 아니면 필드 값으로 찾는다.
        const record = data !== null && typeof data === 'object' ? (getOrigin(data) ?? findDerivedOrigin(data))?.record : undefined;
        if (!record) return;
        const request = requestKeyOf(record);
        const entry = keysByRequest.get(request) ?? { record, keys: new Set<string>() };
        entry.keys.add(keyText(q.queryKey));
        keysByRequest.set(request, entry);
        const seen = rememberRequest(q.queryHash, describeRequest(record));
        if (seen.size > 1) findings.push({ kind: 'key-missing-param', keys: [keyText(q.queryKey)], requests: [...seen] });
        const refetchedSame = records.some((r) => requestKeyOf(r) === request && classOf(r) === 'same-response');
        if (q.observers?.length && staleTimeOf(q) === 0 && refetchedSame) {
          findings.push({ kind: 'stale-zero', keys: [keyText(q.queryKey)], requests: [describeRequest(record)] });
        }
      }),
  );
  keysByRequest.forEach(({ record, keys }) => {
    if (keys.size > 1) findings.push({ kind: 'duplicate-cache', keys: [...keys], requests: [describeRequest(record)] });
  });
  // 같은 종류·키·요청은 하나로 합친다(같은 키를 여러 번 무효화한 경우 등).
  return Array.from(new Map([...findings, ...invalidateMisses].map((f) => [findingId(f), f])).values());
};

/** 점검 결과 하나를 가리키는 문자열(화면 key, 합치기) */
export const findingId = (f: CacheFinding): string => `${f.kind}|${f.keys.join(',')}|${f.requests.join(',')}`;

export const CACHE_FINDING_TEXT: Record<CacheFindingKind, { title: string; fix: string }> = {
  'duplicate-cache': {
    title: '같은 요청을 서로 다른 키로 캐시합니다',
    fix: '같은 데이터면 queryKey 를 하나로 맞추세요. 키가 다르면 캐시를 나눠 써서 같은 요청이 여러 번 나갑니다.',
  },
  'key-missing-param': {
    title: '같은 키에 서로 다른 요청의 데이터가 들어왔습니다',
    fix: '쿼리 함수가 쓰는 값(URL 파라미터, 필터 등)을 queryKey 에 넣으세요. 빠지면 다른 조건의 데이터가 같은 캐시를 덮어씁니다.',
  },
  'invalidate-miss': {
    title: '무효화한 키와 맞는 쿼리가 없습니다',
    fix: 'invalidateQueries 에 준 키(접두사)가 실제 queryKey 와 같은 모양인지 확인하세요. 지금은 아무 쿼리도 새로고치지 않습니다.',
  },
  'stale-zero': {
    title: 'staleTime 이 0 이라 같은 응답을 다시 받습니다',
    fix: '자주 바뀌지 않는 데이터면 staleTime 을 늘리세요(예: 30_000). 화면을 옮기거나 포커스가 돌아올 때마다 같은 요청이 나갑니다.',
  },
};
