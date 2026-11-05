import { config } from '../config.js';
import { groupBy } from '../../shared/collections.js';
import { callerOf } from './callerFrames.js';
import { endpointOf, pathOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

/** 고치는 법. 패널의 N+1 표시와 보고서 summary 가 같이 쓴다 */
export const N_PLUS_ONE_FIX =
  'Fetch these in one request from the list (a batch endpoint, or include/expand the related data in the list response), or fetch once in the parent and pass the data down.';

/** 패널의 N+1 표시에 거는 설명. 기준은 지금 설정(configure 의 nPlusOne)으로 만든다 */
export const nPlusOneHint = (): string => {
  const { nPlusOneCount, nPlusOneWindowMs } = config();
  return `${nPlusOneCount}+ requests for different IDs from the same sender within ${nPlusOneWindowMs}ms (one request per list item). ${N_PLUS_ONE_FIX} May be intended (e.g. a virtualized list).`;
};

type Sender = NonNullable<RequestRecord['nPlusOne']>;

/** 보낸 곳의 키. 컴포넌트, 모르면 호출 위치 */
export const senderKeyOf = (sender: Sender): string => JSON.stringify([sender.component, sender.location]);

/** 같은 패턴으로 묶는 단위: 페이지(load), 엔드포인트(ID 를 ':id' 로 묶은 경로), 보낸 곳. 판정(색인)과 묶음 나누기가 같이 쓴다 */
export const nPlusOneKeyOf = (record: Pick<RequestRecord, 'load'>, endpoint: string, sender: Sender): string =>
  `${record.load ?? 0} ${endpoint} ${senderKeyOf(sender)}`;

// 경로 조각 하나가 정확히 ':id' 인 엔드포인트만 본다(뒤에 연산 이름 등 " (…)" 이 붙을 수 있다).
const HAS_ID_SEGMENT = /\/:id(?=\/|\s|$)/;

/** 판정에 쓰는, 기록마다 한 번 계산하는 값 */
interface Entry {
  record: RequestRecord;
  key: string;
  sender: Sender;
  /** ID 를 묶기 전 경로. 서로 다른 ID 인지 이것으로 가른다 */
  path: string;
}

const senderOf = (r: RequestRecord): Sender | undefined => {
  if (r.component) return { component: r.component };
  const location = r.noAppFrame ? undefined : callerOf(r.stack);
  return location ? { location } : undefined;
};

const entryOf = (r: RequestRecord): Entry | undefined => {
  const endpoint = endpointOf(r);
  const sender = HAS_ID_SEGMENT.test(endpoint) ? senderOf(r) : undefined;
  return sender ? { record: r, key: nPlusOneKeyOf(r, endpoint, sender), sender, path: pathOf(r.url) } : undefined;
};

/**
 * 판정 준비 단계. 보낸 곳(annotate step), 중복 판정(createRecord 의 step), 응답(finishRecord 의 step)이 모두 끝난 기록만 색인에 넣는다.
 * 순서는 보통 이대로지만, 어느 것이 늦어도 마지막 단계의 step 이 판정한다.
 */
export type NPlusOneStage = 'annotated' | 'deduped' | 'finished';
const STAGE_BIT: Record<NPlusOneStage, number> = { annotated: 1, deduped: 2, finished: 4 };
const ALL_STAGES = 7;
const stages = new WeakMap<RequestRecord, number>();

// 패턴별로 시작 시각 순으로 쌓은 기록. 요청 기록(상한)에서 밀려난 기록이 끝없이 남지 않게 오래된 것과 오래된 패턴은 버린다.
const index = new Map<string, Entry[]>();
const MAX_PATTERNS = 500;
// 늦게 준비된 기록도 이웃과 맞춰 볼 수 있게 이만큼은 남긴다(창보다 훨씬 길다).
const KEEP_MS = 60_000;

/** 시작 시각 순으로 넣을 자리. 대개 끝에 붙으므로 뒤에서부터 찾는다 */
const insertAt = (list: readonly Entry[], startedAt: number): number => {
  let i = list.length;
  while (i > 0 && list[i - 1].record.startedAt > startedAt) i--;
  return i;
};

const add = (entry: Entry): { list: Entry[]; at: number } => {
  const list = index.get(entry.key) ?? [];
  index.delete(entry.key); // 다시 넣어 맨 뒤로 보낸다(오래 안 쓴 패턴부터 버린다)
  index.set(entry.key, list);
  if (index.size > MAX_PATTERNS) index.delete(index.keys().next().value as string);
  const at = insertAt(list, entry.record.startedAt);
  list.splice(at, 0, entry);
  const newest = list[list.length - 1].record.startedAt;
  let old = 0;
  while (old < at && list[old].record.startedAt < newest - KEEP_MS) old++;
  list.splice(0, old);
  return { list, at: at - old };
};

/**
 * 새 기록(at)이 든 창만 본다. 창은 windowMs 안에 시작한 연속 구간이고, 서로 다른 경로가 count 개 이상이면 N+1 이다.
 * at 을 품은 창들은 at 근처 [at − 창, at + 창] 안에 있으므로 두 포인터로 O(창 안의 수) 에 끝난다.
 * at 을 품은 N+1 창들의 합은 이어진 구간이고, 그 안의 각 경로 첫 기록을 표시한다.
 */
const flagAround = (list: readonly Entry[], at: number): boolean => {
  const { nPlusOneWindowMs: windowMs, nPlusOneCount: min } = config();
  const start = (i: number) => list[i].record.startedAt;
  let lo = at;
  while (lo > 0 && start(at) - start(lo - 1) <= windowMs) lo--;
  const inWindow = new Map<string, number>();
  const put = (i: number) => inWindow.set(list[i].path, (inWindow.get(list[i].path) ?? 0) + 1);
  for (let i = lo; i <= at; i++) put(i);
  let first = lo;
  let from = -1;
  let to = -1;
  for (let last = at; last < list.length && start(last) - start(at) <= windowMs; last++) {
    if (last > at) put(last);
    while (start(last) - start(first) > windowMs) {
      const left = (inWindow.get(list[first].path) ?? 1) - 1;
      if (left === 0) inWindow.delete(list[first].path);
      else inWindow.set(list[first].path, left);
      first++;
    }
    if (inWindow.size >= min) {
      if (from < 0) from = first;
      to = last;
    }
  }
  if (from < 0) return false;
  let changed = false;
  const seen = new Set<string>();
  for (let i = from; i <= to; i++) {
    const { record, path, sender } = list[i];
    if (seen.has(path)) continue;
    seen.add(path);
    if (record.nPlusOne) continue;
    record.nPlusOne = sender;
    changed = true;
  }
  return changed;
};

/**
 * 한 단계가 끝났다고 알린다. 유휴 큐의 step 안에서 부른다. 세 단계가 모두 끝난 기록이면 색인에 넣고 그 기록이 든 창을 판정한다.
 * 중복(같은 요청이 2초 안에 다시 나간 것)은 낭비 판정이 맡으므로 넣지 않는다. 새로 표시한 기록이 있으면 true.
 */
export const noteNPlusOneStage = (record: RequestRecord, stage: NPlusOneStage): boolean => {
  const done = (stages.get(record) ?? 0) | STAGE_BIT[stage];
  stages.set(record, done);
  if (done !== ALL_STAGES || record.duplicateOf !== undefined || record.restored) return false;
  const entry = entryOf(record);
  if (!entry) return false;
  const { list, at } = add(entry);
  return flagAround(list, at);
};

/** 측정을 새로 시작할 때(clearRecords) 색인을 비운다 */
export const resetNPlusOne = (): void => index.clear();

/** 표시된 N+1 요청을 이어진 묶음으로 나눈 것. 같은 패턴이라도 창보다 길게 끊기면 다른 묶음이다. */
export interface NPlusOneRun {
  endpoint: string;
  component?: string;
  /** 보낸 컴포넌트를 모를 때 묶은 호출 위치(stack 앞쪽 3줄) */
  location?: string;
  records: RequestRecord[];
  /** 서로 다른 경로(ID) 수 */
  distinct: number;
}

/** 표시된 N+1 요청을 패턴별로 모아, 창보다 길게 끊긴 곳에서 묶음을 나눈다. 서로 다른 ID 가 많은 묶음부터. */
export const nPlusOneRuns = (records: readonly RequestRecord[]): NPlusOneRun[] => {
  const windowMs = config().nPlusOneWindowMs;
  const marked = records.filter((r) => r.nPlusOne).sort((a, b) => a.startedAt - b.startedAt);
  const endpoints = new Map(marked.map((r) => [r, endpointOf(r)]));
  const groups = groupBy(marked, (r) => nPlusOneKeyOf(r, endpoints.get(r) ?? '', r.nPlusOne ?? {}));
  const runs: NPlusOneRun[] = [];
  groups.forEach((group) => {
    const { component, location } = group[0].nPlusOne ?? {};
    const base = { endpoint: endpoints.get(group[0]) ?? '', ...(component && { component }), ...(location && { location }) };
    group.forEach((r, i) => {
      const run = runs.at(-1);
      if (i > 0 && run && r.startedAt - group[i - 1].startedAt <= windowMs) run.records.push(r);
      else runs.push({ ...base, records: [r], distinct: 0 });
    });
  });
  runs.forEach((run) => {
    run.distinct = new Set(run.records.map((r) => pathOf(r.url))).size;
  });
  return runs.sort((a, b) => b.distinct - a.distinct);
};
