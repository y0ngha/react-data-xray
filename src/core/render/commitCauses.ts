// 요청 원인 판정(requests)이 렌더 감시(monitor)를 가져오면 import 가 순환하므로, 판정에 쓰는 commit 기록만 여기 둔다.
// commit 순번은 commit 자리에서 올리고(정수 하나), 내용은 monitor 가 유휴 큐에서 그 commit 의 사본으로 적는다.

/** 한 commit 에서 한 컴포넌트 이름이 렌더된 기록. 같은 이름의 인스턴스가 여럿이면 합친다. */
export interface CommitCause {
  seq: number;
  /** commit 시각(ms). 마운트 commit 과 요청 사이가 벌어졌는지 볼 때 쓴다 */
  time?: number;
  /** 이 commit 에서 마운트됐다(이전 렌더 없음). StrictMode 는 마운트할 때만 effect 를 두 번 돌린다 */
  mounted?: boolean;
  /** 이 commit 에서 다시 마운트됐다(언마운트 뒤 곧 다시 생김). parent 는 서브트리를 갈아 끼운 부모 */
  remount?: { parent: string; typeChanged: boolean };
  /** 이 commit 에서 처음 바뀐 effect 의존성. 마운트(이전 렌더 없음)는 없다 */
  deps?: string;
  /** 마운트했을 때, 그 마운트 렌더의 네트워크 원인 요청 id(응답 객체로 확인한 것만. 응답 → 마운트 → 요청 워터폴 판정용, requests/waterfall) */
  causedBy?: number;
}

const MAX_NAMES = 1000;
// 이름마다 최근 몇 commit 만 둔다. 원인 판정은 요청 직후 유휴 큐에서 돌아 그 사이 commit 이 많지 않다.
const PER_NAME = 16;

let seq = 0;
const byName = new Map<string, CommitCause[]>();
// 렌더 기록을 남긴 commit 순번(감시가 꺼져 있던 commit 은 없다). 기록이 없는 것과 "그 commit 에 렌더되지 않음"을 가른다.
const MAX_RECORDED = 1000;
const recorded = new Set<number>();

/** commit 마다 부른다(앱 경로라 순번만 올린다). 앞 commit 의 passive effect 는 다음 commit 전에 모두 돌므로, 요청은 그때의 순번에 속한다. */
export const nextCommitSeq = (): number => ++seq;

/** 지금까지의 마지막 commit 순번. 요청을 만들 때 담는다. */
export const currentCommitSeq = (): number => seq;

export const noteCommitCause = (name: string, at: number, change: Omit<CommitCause, 'seq'>): void => {
  if (!recorded.has(at)) {
    recorded.add(at);
    if (recorded.size > MAX_RECORDED) recorded.delete(recorded.values().next().value as number);
  }
  let list = byName.get(name);
  if (!list) {
    byName.set(name, (list = []));
    if (byName.size > MAX_NAMES) byName.delete(byName.keys().next().value as string);
  }
  const last = list.at(-1);
  if (last?.seq === at) {
    last.mounted ||= change.mounted;
    last.time ??= change.time;
    last.remount ??= change.remount;
    last.deps ??= change.deps;
    last.causedBy ??= change.causedBy;
    return;
  }
  list.push({ seq: at, ...change });
  if (list.length > PER_NAME) list.shift();
};

/** 이 이름이 after 순번 뒤부터 upTo 순번까지(포함) 렌더된 기록(오래된 것부터). 렌더 기록이 없으면 빈 배열. */
export const commitCausesBetween = (name: string, after: number, upTo: number): CommitCause[] =>
  (byName.get(name) ?? []).filter((c) => c.seq > after && c.seq <= upTo);

/** 렌더 기록이 하나라도 있는가(감시가 켜져 있었다). 없으면 요청마다 렌더 기록으로 정하는 판정 step 을 걸지 않는다. */
export const hasCommitRecords = (): boolean => recorded.size > 0;

/** 이 순번의 commit 에 렌더 기록이 남아 있는가. 없으면 감시가 꺼져 있었거나(앱의 첫 commit 은 대개 RDX 버튼이 감시를 켜기 전이다) 기록을 비운 뒤다. */
export const hasCommitRecord = (at: number): boolean => recorded.has(at);

/** 감시를 새로 시작할 때 비운다. 순번은 이어 간다(앞서 만든 요청의 순번과 섞이지 않게). */
export const resetCommitCauses = (): void => {
  byName.clear();
  recorded.clear();
};
