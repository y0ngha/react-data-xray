import { groupBy } from '../../shared/collections.js';
import { callerOf } from './callerFrames.js';
import { endpointOf, pathOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

/** 이 시간 안에 */
export const N_PLUS_ONE_WINDOW_MS = 1000;
/** 서로 다른 ID 로 이만큼 이상 나가면 항목마다 보낸 요청(N+1)으로 본다 */
export const N_PLUS_ONE_MIN = 5;

/** 고치는 법. 패널의 N+1 표시와 보고서 summary 가 같이 쓴다 */
export const N_PLUS_ONE_FIX =
  'Fetch these in one request from the list (a batch endpoint, or include/expand the related data in the list response), or fetch once in the parent and pass the data down.';

/** 패널의 N+1 표시에 거는 설명 */
export const N_PLUS_ONE_HINT = `${N_PLUS_ONE_MIN}+ requests for different IDs from the same sender within ${N_PLUS_ONE_WINDOW_MS / 1000}s (one request per list item). ${N_PLUS_ONE_FIX} May be intended (e.g. a virtualized list).`;

type Sender = NonNullable<RequestRecord['nPlusOne']>;

/**
 * 같은 패턴으로 묶을 단위: 페이지(load), 엔드포인트(ID 를 ':id' 로 묶은 경로), 보낸 곳.
 * 보낸 곳은 컴포넌트, 모르면 호출 위치(stack 앞쪽 3줄)다. 둘 다 모르면(스택이 끊긴 요청) 짚지 않는다.
 * 경로에 ID 가 없는 엔드포인트(쿼리만 다른 검색 등)도 짚지 않는다.
 */
interface Pattern {
  key: string;
  sender: Sender;
}

// 그룹 키 계산(URL 파싱)은 기록마다 한 번만 한다. 보낸 컴포넌트·스택은 annotate step 이 앞서 채운 뒤라 바뀌지 않는다.
const patterns = new WeakMap<RequestRecord, Pattern | null>();

const senderOf = (r: RequestRecord): Sender | undefined => {
  if (r.component) return { component: r.component };
  const location = r.noAppFrame ? undefined : callerOf(r.stack);
  return location ? { location } : undefined;
};

const patternOf = (r: RequestRecord): Pattern | null => {
  const known = patterns.get(r);
  if (known !== undefined) return known;
  const endpoint = endpointOf(r);
  const sender = endpoint.includes(':id') ? senderOf(r) : undefined;
  const pattern = sender ? { key: JSON.stringify([r.load ?? 0, endpoint, sender.component, sender.location]), sender } : null;
  patterns.set(r, pattern);
  return pattern;
};

/**
 * 정렬된 같은 패턴 요청에서 1초 창 안에 서로 다른 경로(ID)가 5개 이상인 창을 찾아, 창 안의 각 경로의 첫 요청을 고른다(두 포인터).
 * 같은 경로가 다시 나간 것(쿼리만 다른 것 포함)은 세지도 고르지도 않는다.
 */
const flaggedIn = (sorted: readonly RequestRecord[]): Set<RequestRecord> => {
  const flagged = new Set<RequestRecord>();
  const paths = sorted.map((r) => pathOf(r.url));
  const inWindow = new Map<string, number>(); // 창 안 경로별 수
  let first = 0;
  for (let last = 0; last < sorted.length; last++) {
    inWindow.set(paths[last], (inWindow.get(paths[last]) ?? 0) + 1);
    while (sorted[last].startedAt - sorted[first].startedAt > N_PLUS_ONE_WINDOW_MS) {
      const left = (inWindow.get(paths[first]) ?? 1) - 1;
      if (left === 0) inWindow.delete(paths[first]);
      else inWindow.set(paths[first], left);
      first++;
    }
    if (inWindow.size < N_PLUS_ONE_MIN) continue;
    const seen = new Set<string>();
    for (let i = first; i <= last; i++) {
      if (seen.has(paths[i])) continue;
      seen.add(paths[i]);
      flagged.add(sorted[i]);
    }
  }
  return flagged;
};

/**
 * 끝난 요청이 든 패턴을 다시 보고 N+1 에 든 요청에 표시한다. 유휴 큐에서 요청이 끝날 때마다 부른다(store.finishRecord).
 * 중복(같은 요청이 2초 안에 다시 나간 것)은 낭비 판정이 따로 하므로 넣지 않는다. 새로 표시한 것이 있으면 true.
 */
export const markNPlusOne = (record: RequestRecord, records: readonly RequestRecord[]): boolean => {
  const pattern = patternOf(record);
  if (!pattern || record.duplicateOf !== undefined) return false;
  const same = records
    .filter((r) => r.duplicateOf === undefined && patternOf(r)?.key === pattern.key)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (same.length < N_PLUS_ONE_MIN) return false;
  let changed = false;
  flaggedIn(same).forEach((r) => {
    if (r.nPlusOne) return;
    r.nPlusOne = pattern.sender;
    changed = true;
  });
  return changed;
};

/** 표시된 N+1 요청을 이어진 묶음으로 나눈 것. 같은 패턴이라도 1초 넘게 끊기면 다른 묶음이다. */
export interface NPlusOneRun {
  endpoint: string;
  component?: string;
  /** 보낸 컴포넌트를 모를 때 묶은 호출 위치(stack 앞쪽 3줄) */
  location?: string;
  records: RequestRecord[];
}

/** 표시된 N+1 요청을 페이지·엔드포인트·보낸 곳별로 모아, 1초 넘게 끊긴 곳에서 묶음을 나눈다. 큰 묶음부터. */
export const nPlusOneRuns = (records: readonly RequestRecord[]): NPlusOneRun[] => {
  const marked = records.filter((r) => r.nPlusOne).sort((a, b) => a.startedAt - b.startedAt);
  const groups = groupBy(marked, (r) => JSON.stringify([r.load ?? 0, endpointOf(r), r.nPlusOne?.component, r.nPlusOne?.location]));
  const runs: NPlusOneRun[] = [];
  groups.forEach((group) => {
    const { component, location } = group[0].nPlusOne ?? {};
    const base = { endpoint: endpointOf(group[0]), ...(component && { component }), ...(location && { location }) };
    group.forEach((r, i) => {
      const run = runs.at(-1);
      if (i > 0 && run && r.startedAt - group[i - 1].startedAt <= N_PLUS_ONE_WINDOW_MS) run.records.push(r);
      else runs.push({ ...base, records: [r] });
    });
  });
  return runs.sort((a, b) => b.records.length - a.records.length);
};
