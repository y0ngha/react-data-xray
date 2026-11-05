import { commitCausesBetween } from '../render/commitCauses.js';
import { endpointOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

// 마운트 commit 의 effect 가 보낸 요청은 commit 직후에 나간다(repeatCause 의 MOUNT_TO_REQUEST_MS 와 같다). 이보다 늦으면 마운트 뒤 핸들러가 보낸 것이다.
const MOUNT_TO_REQUEST_MS = 2000;
// 고리 하나에 담는 요청 수 상한과, 기록에서 찾는 고리 수 상한(목록 행이 모두 마운트되며 요청을 보내는 화면)
const MAX_DEPTH = 10;
const MAX_PATHS = 200;

/**
 * 이 요청이 기다린 앞 요청: 보낸 컴포넌트가 요청 순번의 commit(useLayoutEffect 면 다음 순번)에서 마운트됐고, 그 마운트 렌더의
 * 네트워크 원인이 앞 요청이며, 이 요청은 그 commit 뒤 2초 안에, 앞 요청의 응답이 온 뒤에 나갔다.
 * 응답 전에 시작한 요청(같은 때 병렬로 나간 요청)은 기다린 것이 아니다. StrictMode 가 effect 를 다시 돌려 보낸 요청은 건너뛴다.
 * shortcut: 컴포넌트는 이름으로 맞춘다. 같은 이름의 다른 인스턴스가 같은 commit 에서 응답 때문에 마운트됐으면 그것으로 본다.
 */
const waterfallParentOf = (record: RequestRecord, records: readonly RequestRecord[]): number | undefined => {
  const at = record.commitSeq;
  const component = record.component;
  if (at === undefined || !component || record.strictModeReplay) return undefined;
  const mount = commitCausesBetween(component, at - 1, at + 1).find(
    (c) => c.mounted && c.causedBy !== undefined && c.time !== undefined && Math.abs(record.startedAt - c.time) <= MOUNT_TO_REQUEST_MS,
  );
  if (!mount || mount.causedBy === record.id) return undefined;
  const parent = records.find((r) => r.id === mount.causedBy);
  return parent && record.startedAt >= parent.startedAt + parent.durationMs ? parent.id : undefined;
};

/**
 * record.waterfallFrom 을 채우는 큐 step. 렌더 기록은 이름마다 최근 몇 commit 만 남으므로 요청을 만든 직후에 정해 고정한다.
 * 보낸 컴포넌트를 채우는 step, 그리고 useLayoutEffect 가 보낸 요청이면 그 다음 commit 의 렌더 기록 step 뒤에 걸어야 한다.
 * records 는 끝난 요청 목록(store 의 배열. store 가 이 파일을 가져오므로 넘겨받는다)이다.
 */
export const waterfallStep =
  (record: RequestRecord, records: readonly RequestRecord[]): (() => boolean) =>
  () => {
    record.waterfallFrom = waterfallParentOf(record, records);
    return true;
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

/** 앞 요청이 없는(또는 기록에서 밀려난) 요청부터 뒤 요청을 따라 끝까지 간 고리들. 요청 둘 이상인 것만. */
const pathsOf = (records: readonly RequestRecord[]): RequestRecord[][] => {
  const byId = new Map(records.map((r) => [r.id, r]));
  const next = new Map<number, RequestRecord[]>();
  records.forEach((r) => {
    if (r.waterfallFrom === undefined || !byId.has(r.waterfallFrom)) return;
    const list = next.get(r.waterfallFrom) ?? [];
    list.push(r);
    next.set(r.waterfallFrom, list);
  });
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
    if (next.has(r.id) && (r.waterfallFrom === undefined || !byId.has(r.waterfallFrom))) walk([r]);
  });
  return paths;
};

/**
 * 기록에서 응답 → 마운트 → 요청 고리를 찾아, 엔드포인트·보낸 컴포넌트가 같은 고리끼리 합친다(지연이 큰 순).
 * locate 는 요청을 보낸 코드 위치를 돌려준다.
 */
export const findWaterfalls = (records: readonly RequestRecord[], locate: (r: RequestRecord) => string | undefined): Waterfall[] => {
  const groups = new Map<string, RequestRecord[][]>();
  pathsOf(records).forEach((path) => {
    const key = JSON.stringify(path.map((r) => [endpointOf(r), r.component]));
    groups.set(key, [...(groups.get(key) ?? []), path]);
  });
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
