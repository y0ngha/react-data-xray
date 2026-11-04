import { commitCausesBetween, type CommitCause } from '../render/commitCauses.js';
import { getMountStats } from '../render/mounts.js';
import type { RequestRecord } from './types.js';

export type RepeatCause = NonNullable<RequestRecord['repeatCause']>;

// 렌더 기록이 없을 때만 쓴다: 요청이 나가기 이만큼 안에 다시 마운트된 것을 원인으로 본다(mounts.ts 의 REMOUNT_MS 와 같다).
const REMOUNT_WINDOW_MS = 5000;

const remountCause = (component: string, parent: string, typeChanged: boolean): RepeatCause => {
  const by = `parent <${parent || 'root'}>`;
  return {
    kind: 'remount',
    detail: typeChanged
      ? `<${component}> remount, ${by} defines a component during render so the type changes every render (component defined during render)`
      : `<${component}> remount, ${by} branch changed`,
  };
};

/** 렌더 기록이 없을 때(감시를 늦게 켬): 요청 시작 전 5초 안의 재마운트 */
const recentRemountOf = (record: RequestRecord, component: string): RepeatCause | undefined => {
  const remount = getMountStats(component).remounts.find(
    (r) => r.lastAt <= record.startedAt && record.startedAt - r.lastAt <= REMOUNT_WINDOW_MS,
  );
  return remount && remountCause(component, remount.parent, remount.cause === 'type-changed');
};

/**
 * 요청을 보낸 commit 의 기록으로 이유를 정한다. 기록은 monitor 가 그 commit 의 사본으로 적어 둔 것이라, 요청 뒤에 다시 렌더돼도 바뀌지 않는다.
 * - 요청 순번의 commit 에 이 컴포넌트가 렌더됐으면 그 commit 만 본다(effect 에서 바로 보낸 요청).
 * - 아니면(await 뒤에 보내 그 사이 다른 commit 이 낌) 앞선 같은 요청 뒤의 이 컴포넌트 렌더를 모두 본다.
 * 본 렌더에 재마운트와 의존성 변경이 함께 있으면 어느 쪽이 보냈는지 몰라 비워 둔다(같은 이름의 다른 인스턴스, 또는 재마운트 뒤 함수 의존성만 바뀐 렌더).
 * shortcut: useLayoutEffect 의 요청은 commit 순번이 오르기 전이라 앞 commit 에 속한다. 그때는 아래 범위 규칙으로 본다.
 */
const causeOf = (component: string, seen: readonly CommitCause[]): RepeatCause | undefined => {
  const remount = seen.find((c) => c.remount)?.remount;
  const deps = seen.find((c) => c.deps)?.deps;
  if (remount && deps) return undefined;
  if (remount) return remountCause(component, remount.parent, remount.typeChanged);
  return deps ? { kind: 'deps', detail: deps } : undefined;
};

const repeatCauseOf = (record: RequestRecord, previousSeq: number | undefined): RepeatCause | undefined => {
  if (!record.duplicateOf) return undefined;
  if (record.strictModeReplay) return { kind: 'strict', detail: 'StrictMode re-ran the effect during development' };
  const component = record.component;
  if (!component) return undefined;
  const at = record.commitSeq;
  if (at === undefined) return recentRemountOf(record, component);
  const exact = commitCausesBetween(component, at - 1, at);
  if (exact.length > 0) return causeOf(component, exact);
  // 이 컴포넌트의 렌더 기록이 아예 없으면(감시를 늦게 켬) 재마운트 통계로만 본다.
  if (commitCausesBetween(component, -Infinity, at).length === 0) return recentRemountOf(record, component);
  // 앞선 요청의 순번을 모르면(새로고침 전 기록) 범위를 정할 수 없어 비워 둔다.
  return previousSeq === undefined ? undefined : causeOf(component, commitCausesBetween(component, previousSeq, at));
};

/** 보낸 컴포넌트가 요청 순번의 commit 에서 마운트됐는가. 렌더 기록은 이름마다 최근 몇 commit 만 남아 지금 정해 고정한다. 모르면 undefined. */
const sentOnMountOf = (record: RequestRecord): boolean | undefined => {
  const at = record.commitSeq;
  if (!record.component || at === undefined) return undefined;
  return commitCausesBetween(record.component, at - 1, at).some((c) => c.mounted) || undefined;
};

/**
 * record.repeatCause 와 sentOnMount 를 채우는 큐 step. 끝나면 true. 앱 경로가 아니라 유휴 큐에서 부른다(보낸 컴포넌트를 채우는 step 뒤에 걸린다).
 * previousSeq 는 앞선 같은 요청(duplicateOf)을 만들 때의 commit 순번이다.
 */
export const repeatCauseStep =
  (record: RequestRecord, previousSeq?: number): (() => boolean) =>
  () => {
    record.repeatCause = repeatCauseOf(record, previousSeq);
    record.sentOnMount = sentOnMountOf(record);
    return true;
  };
