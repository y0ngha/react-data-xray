import { collectValues } from '../fiber/componentValues.js';
import { findRootFibers, getComponentName, walkFibers } from '../fiber/tree.js';
import { findQueryClients } from '../reactQuery/cacheAudit.js';
import { getOrigin } from '../requests/origins.js';
import type { RequestRecord } from '../requests/types.js';

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

/**
 * 이 요청이 React Query 쿼리가 가져온 응답이면 그 queryKey 와 useQuery 를 그린 컴포넌트.
 * 응답 데이터가 이 요청에서 온 것(같은 참조)인 쿼리만 쓴다. 스택이 비동기 경계에서 끊겨도 "어느 훅이 불렀나"가 남는다.
 * 사용자 조회·보고서에서만 부른다(트리를 걷는다).
 */
export const queryContextOf = (record: RequestRecord): QueryContext | undefined => {
  const { clients, byKey } = current();
  for (const client of clients) {
    for (const q of client.getQueryCache().getAll()) {
      const data = q.state.data;
      if (data === null || typeof data !== 'object' || getOrigin(data)?.record !== record) continue;
      const queryKey = JSON.stringify(q.queryKey);
      const observer = byKey.get(queryKey);
      return observer ? { queryKey, observer } : { queryKey };
    }
  }
  return undefined;
};
