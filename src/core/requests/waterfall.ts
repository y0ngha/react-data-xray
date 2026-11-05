import { groupBy } from '../../shared/collections.js';
import { mountAt } from './repeatCause.js';
import { endpointOf, requestKeyOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

// 고리 하나에 담는 요청 수 상한과, 기록에서 찾는 고리 수 상한(목록 행이 모두 마운트되며 요청을 보내는 화면)
const MAX_DEPTH = 10;
const MAX_PATHS = 200;

/**
 * 이 요청이 기다린 앞 요청의 id: 보낸 컴포넌트가 이 요청을 마운트 effect 에서 보낸 commit(`mountAt`)의 마운트 렌더 원인이 앞 요청이고,
 * 이 요청은 앞 요청의 응답이 온 뒤에 나갔다. 응답 전에 시작한 요청(같은 때 병렬로 나간 요청)은 기다린 것이 아니다.
 * 마운트 원인은 응답 객체로 확인한 것만 담긴다(시간으로만 짐작한 timing 원인과 그것을 이어받은 렌더는 빠진다, render/monitor).
 * StrictMode 재실행 요청도 잇는다(첫 실행은 대개 cleanup 이 취소해 그 응답으로 다음 고리가 이어지지 않는다). 같은 요청 둘은 고리를 셀 때 하나로 본다.
 * 렌더 기록은 이름마다 최근 몇 commit 만 남으므로 요청을 만든 직후 유휴 큐에서 정해 고정한다(requests/store).
 * records 는 끝난 요청 목록(store 의 배열. store 가 이 파일을 가져오므로 넘겨받는다)이다.
 * shortcut: 컴포넌트는 이름으로 맞춘다. 같은 이름의 다른 인스턴스가 같은 commit 에서 응답 때문에 마운트됐으면 그것으로 본다.
 */
export const waterfallParentOf = (record: RequestRecord, records: readonly RequestRecord[]): number | undefined => {
  const causedBy = mountAt(record)?.causedBy;
  if (causedBy === undefined) return undefined;
  const parent = records.find((r) => r.id === causedBy);
  return parent && record.startedAt >= parent.startedAt + parent.durationMs ? parent.id : undefined;
};

export interface WaterfallStep {
  endpoint: string;
  component?: string;
  /** 요청을 보낸 앱 코드 위치(알 때만) */
  location?: string;
  /** 응답 시간(같은 고리가 여러 번이면 평균) */
  ms: number;
}

export interface Waterfall {
  /** 앞 요청부터. 다음 요청은 앞 요청의 응답이 마운트한 컴포넌트가 보냈다 */
  chain: WaterfallStep[];
  /** 고리의 요청 수(2 이상) */
  depth: number;
  /** 고리의 응답 시간 합(ms). 차례로 기다려 늘어난 지연이다 */
  latencyMs: number;
  /** 같은 고리(엔드포인트·컴포넌트가 같다)가 나타난 횟수. 첫 요청이 같으면(목록 행마다, StrictMode 재실행) 한 번으로 센다 */
  count: number;
}

/**
 * 한 앞 요청 뒤에 같은 컴포넌트가 같은 commit 에서 보낸 같은 요청(StrictMode 가 effect 를 두 번 돌림)은 하나만 남긴다.
 * 취소·실패하지 않은 것(대개 재실행 쪽)을, 둘 다 같으면 나중 것을 고른다. 다른 요청(목록 행마다 다른 id)은 그대로 둔다.
 */
const distinctChildren = (children: readonly RequestRecord[]): RequestRecord[] =>
  Array.from(groupBy(children, (r) => `${requestKeyOf(r)}|${r.component ?? ''}|${r.commitSeq ?? ''}`).values(), (same) =>
    same.reduce((best, r) => (!r.error || best.error ? r : best)),
  );

/** 앞 요청이 없는(또는 기록에서 밀려난) 요청부터 뒤 요청을 따라 끝까지 간 고리들. 요청 둘 이상인 것만. */
const pathsOf = (records: readonly RequestRecord[]): RequestRecord[][] => {
  const ids = new Set(records.map((r) => r.id));
  const linked = (r: RequestRecord) => r.waterfallFrom !== undefined && ids.has(r.waterfallFrom);
  const next = new Map(
    Array.from(
      groupBy(records.filter(linked), (r) => r.waterfallFrom!),
      ([id, children]) => [id, distinctChildren(children)],
    ),
  );
  const paths: RequestRecord[][] = [];
  const walk = (path: RequestRecord[]): void => {
    if (paths.length >= MAX_PATHS) return;
    const children = next.get(path[path.length - 1].id);
    if (!children || path.length >= MAX_DEPTH) {
      if (path.length >= 2) paths.push(path);
      return;
    }
    children.forEach((c) => walk([...path, c]));
  };
  records.forEach((r) => {
    if (next.has(r.id) && !linked(r)) walk([r]);
  });
  return paths;
};

/**
 * 기록에서 응답 → 마운트 → 요청 고리를 찾아, 엔드포인트·보낸 컴포넌트가 같은 고리끼리 합친다(지연이 큰 순).
 * locate 는 요청을 보낸 코드 위치를 돌려준다.
 */
export const findWaterfalls = (records: readonly RequestRecord[], locate: (r: RequestRecord) => string | undefined): Waterfall[] => {
  const groups = groupBy(pathsOf(records), (path) => JSON.stringify(path.map((r) => [endpointOf(r), r.component])));
  return Array.from(groups.values())
    .map((paths): Waterfall => {
      const chain = paths[paths.length - 1].map((r, i): WaterfallStep => {
        const location = locate(r);
        return {
          endpoint: endpointOf(r),
          ...(r.component && { component: r.component }),
          ...(location && { location }),
          ms: Math.round(paths.reduce((n, p) => n + p[i].durationMs, 0) / paths.length),
        };
      });
      const count = new Set(paths.map((p) => p[0].id)).size;
      return { chain, depth: chain.length, latencyMs: chain.reduce((n, s) => n + s.ms, 0), count };
    })
    .sort((a, b) => b.latencyMs - a.latencyMs);
};
