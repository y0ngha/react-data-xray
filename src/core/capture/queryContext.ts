import { collectValues } from '../fiber/componentValues.js';
import { findRootFibers, getComponentName, walkFibers } from '../fiber/tree.js';
import { findQueryClients } from '../reactQuery/cacheAudit.js';
import { getOrigin } from '../requests/origins.js';
import { requestKeyOf } from '../requests/requestKey.js';
import type { Origin, RequestRecord } from '../requests/types.js';

export interface QueryContext {
  queryKey: string;
  observer?: string;
}

const OBSERVER_TTL_MS = 1000;
let snapshot: { at: number; clients: ReturnType<typeof findQueryClients>; byKey: Map<string, string> } | undefined;

/** 화면의 QueryClient 와 useQuery 를 그린 컴포넌트(queryKey JSON → 이름). 보고서가 요청마다 트리를 걷지 않게 잠깐 둔다. */
const current = () => {
  const now = Date.now();
  if (snapshot && now - snapshot.at < OBSERVER_TTL_MS) return snapshot;
  const byKey = new Map<string, string>();
  findRootFibers().forEach((root) =>
    walkFibers(root.child, (fiber) => {
      collectValues(fiber).forEach((v) => {
        if (v.via !== 'useQuery') return;
        const key = JSON.stringify(v.queryKey);
        if (!byKey.has(key)) byKey.set(key, getComponentName(fiber));
      });
      return true;
    }),
  );
  snapshot = { at: now, clients: findQueryClients(), byKey };
  return snapshot;
};

// 한 번 찾은 결과는 쿼리가 gc 되거나 데이터가 바뀌어도 그 요청에 남긴다(보고서 출력이 캐시 상태로 흔들리지 않게).
const known = new WeakMap<RequestRecord, QueryContext>();

/** 이미 찾아 둔 문맥만 돌려준다(트리를 걷지 않는다). 주기 업로드처럼 앱 경로 가까이서 부를 때 쓴다. */
export const knownQueryContextOf = (record: RequestRecord): QueryContext | undefined => known.get(record);

const MAX_CHILDREN = 20;

/** 데이터 자신의 출처. 가공해 감싼 데이터면 출처가 있는 첫 하위 객체의 것. */
const originOf = (data: object): Origin | undefined => {
  const own = getOrigin(data);
  if (own) return own;
  const children = Array.isArray(data) ? data : Object.values(data);
  for (let i = 0; i < Math.min(children.length, MAX_CHILDREN); i++) {
    const child: unknown = children[i];
    const origin = child !== null && typeof child === 'object' ? getOrigin(child) : undefined;
    if (origin) return origin;
  }
  return undefined;
};

const remember = (record: RequestRecord, queryKey: string, byKey: ReadonlyMap<string, string>): QueryContext => {
  const observer = byKey.get(queryKey);
  const context = observer ? { queryKey, observer } : { queryKey };
  known.set(record, context);
  return context;
};

/**
 * 이 요청이 React Query 쿼리가 가져온 응답이면 그 queryKey 와 useQuery 를 그린 컴포넌트.
 * 쿼리 데이터의 출처가 이 요청이면 쓰고, 구조적 공유로 데이터가 앞 응답 그대로인 재조회는 출처 요청과 같은 요청(requestKeyOf)이면 쓴다.
 * 스택이 비동기 경계에서 끊겨도 "어느 훅이 불렀나"가 남는다.
 * 사용자 조회·보고서에서만 부른다(트리를 걷는다).
 * shortcut: 같은 URL 을 React Query 밖에서 부른 요청도 같은 쿼리로 본다.
 */
export const queryContextOf = (record: RequestRecord): QueryContext | undefined => {
  const cached = known.get(record);
  if (cached?.observer) return cached; // observer 를 모르면 다시 찾아 본다
  const { clients, byKey } = current();
  const key = requestKeyOf(record);
  let sameRequest: string | undefined;
  for (const client of clients) {
    for (const q of client.getQueryCache().getAll()) {
      const data = q.state.data;
      if (data === null || typeof data !== 'object') continue;
      const origin = originOf(data);
      if (!origin) continue;
      if (origin.record === record) return remember(record, JSON.stringify(q.queryKey), byKey);
      if (sameRequest === undefined && requestKeyOf(origin.record) === key) sameRequest = JSON.stringify(q.queryKey);
    }
  }
  return sameRequest === undefined ? cached : remember(record, sameRequest, byKey);
};
