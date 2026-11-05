import { hostNodesOf, isMounted, knownRootFibers } from '../fiber/tree.js';
import { HOST_COMPONENT, isComposite, type Fiber } from '../fiber/types.js';
import { currentCommitSeq } from '../render/commitCauses.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { isFailed } from '../requests/classify.js';
import { isMutating } from '../requests/methods.js';
import { endpointOf } from '../requests/requestKey.js';
import { getRecords, subscribe, touchRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { groupBy } from '../../shared/collections.js';
import { readIgnoredEndpoints, type IgnoreMatcher } from '../../shared/ignoredEndpoints.js';
import { isOwnUi } from '../../shared/ownUi.js';
import { queueIndex } from './derivedMatch.js';
import { createFiberHolds, keyOfRecord } from './holders.js';
import type { ConsumerMatch } from './types.js';

/**
 * 응답이 오고 이만큼 뒤에 판정한다. 응답 → setState → 렌더(React Query 는 구독자에게 알리고 다시 그림)가 끝날 시간이다.
 * 너무 짧으면 아직 그리지 않은 응답을 쓰지 않는다고 하고, 너무 길면 그 사이 화면을 떠나 쓰던 컴포넌트가 사라진다.
 */
export const UNUSED_SETTLE_MS = 3000;

// 한 step 에 쓰는 시간. 큐 조각(4ms)을 넘지 않게 시간으로 끊는다(derivedMatch 와 같다). 훑는 쪽은 fiber·객체 32개·파생 후보마다 멈춘다.
const STEP_MS = 1;
// 훑는 사이 commit 이 트리를 바꿨으면 못 찾은 요청만 다시 훑는다. 쉬지 않고 그리는 화면에서 끝없이 돌지 않게 이만큼만 하고, 그래도 바뀌면 판정하지 않는다.
const MAX_ATTEMPTS = 3;

// 이만큼 훑어도 원시값이 없으면 내용이 있다고 본다(판정은 지금처럼 한다). 비어 있기만 한 구조는 이보다 훨씬 작다.
const MAX_CONTENT_NODES = 1000;

/**
 * 출처를 찾을 수 있는 본문: 원시값(문자열·숫자·불리언·null)이 하나라도 있는 JSON 객체·배열.
 * {"disabledModels":[]} 처럼 키만 있고 값이 모두 빈 구조는 그릴 값도 들고 있을 값도 없어 쓰는 곳을 찾을 수 없다(#123).
 * 첫 원시값에서 멈추므로 보통 응답은 곧바로 끝난다.
 */
const hasContent = (body: unknown): boolean => {
  if (body === null || typeof body !== 'object') return false;
  const stack: object[] = [body];
  let seen = 1;
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child === null || typeof child !== 'object') return true;
      if (++seen > MAX_CONTENT_NODES) return true;
      stack.push(child);
    }
  }
  return false;
};

/**
 * 판정할 요청인가. 변경 요청(POST 등)의 응답은 결과 확인용이라 그리지 않아도 정상이고, 실패 응답·빈 본문·JSON 이 아닌 응답(body 가 없다)은
 * 쓸 데이터가 없다. 무시한 엔드포인트(패널·configure({ ignore }))는 사용자가 의도된 요청이라고 했다(ignored 를 줄 때만 본다).
 * 새로고침 전 기록은 응답 객체가 없어 찾을 수 없다.
 */
export const isJudgeable = (record: RequestRecord, ignored?: IgnoreMatcher): boolean =>
  !record.restored && !isMutating(record.method) && !isFailed(record) && hasContent(record.body) && !ignored?.sourceOf(endpointOf(record));

/** rdx 자신이 그린 DOM 의 fiber. 그 아래(패널은 요청 기록을 props 로 들고 있다)는 내려가지 않는다. */
const isOwnHost = (fiber: Fiber): boolean => fiber.tag === HOST_COMPONENT && fiber.stateNode instanceof Element && isOwnUi(fiber.stateNode);

const showsOutsideRdx = (fiber: Fiber): boolean => hostNodesOf(fiber).some((n) => !isOwnUi(n));

/** 조각 사이 commit 이 있었을 때, 찾은 fiber 가 아직 화면에 붙어 있는지(루트까지 이어지고, 그린 DOM 이 문서에 있다) */
const stillShown = (fiber: Fiber): boolean => isMounted(fiber) && hostNodesOf(fiber).some((n) => n.isConnected && !isOwnUi(n));

/**
 * 트리를 한 번 깊이 우선으로 훑으며 remaining 의 요청 키를 들고 있는 컴포넌트를 찾는다. 찾은 키는 found 로 옮긴다. 다 찾으면 멈춘다.
 * walkFibers 와 같은 순서(자기 → 자식 → 형제)를 멈췄다 이어 갈 수 있게 스택으로 돈다.
 */
function* pass(
  roots: readonly Fiber[],
  match: ConsumerMatch,
  remaining: Set<string>,
  found: Map<string, Fiber>,
): Generator<void, void, void> {
  const holds = createFiberHolds(match);
  const stack = roots
    .map((root) => root.child)
    .filter((f): f is Fiber => !!f)
    .reverse();
  while (stack.length > 0 && remaining.size > 0) {
    const fiber = stack.pop()!;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (isOwnHost(fiber)) continue;
    if (fiber.child) stack.push(fiber.child);
    if (!isComposite(fiber)) continue;
    yield;
    const held = yield* holds(fiber, remaining);
    if (held.length === 0 || !showsOutsideRdx(fiber)) continue;
    held.forEach(({ key }) => {
      found.set(key, fiber);
      remaining.delete(key);
    });
  }
}

const isLive = (record: RequestRecord): boolean => getRecords().includes(record);

/**
 * 한 번에 모인 요청들을 트리 한 번(참조, 못 찾은 것만 파생 한 번 더)으로 함께 판정한다. 같은 요청 키는 함께 정한다.
 * 훑는 사이 commit 이 없었으면 못 찾은 것은 unused 다. commit 이 있었으면 찾은 fiber 가 아직 붙어 있을 때만 쓰는 것으로 정하고,
 * 나머지는 다시 훑는다. MAX_ATTEMPTS 번 모두 commit 이 끼면 남은 것은 판정하지 않는다(흔들리는 트리로 unused 라고 하지 않는다).
 * 기억한 React 루트가 없으면 판정하지 않는다(문서 전체를 훑지 않는다).
 * @returns unused 로 정한 요청이 있는지
 */
function* judgeRound(records: readonly RequestRecord[]): Generator<void, boolean, void> {
  const byKey = groupBy(records, keyOfRecord);
  const unresolved = new Set(byKey.keys());
  let marked = false;
  const settle = (key: string, unused: boolean): void => {
    byKey.get(key)?.forEach((r) => {
      if (isLive(r)) r.unused = unused;
    });
    marked ||= unused;
    unresolved.delete(key);
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS && unresolved.size > 0; attempt++) {
    const roots = knownRootFibers();
    if (roots.length === 0) return marked;
    const seq = currentCommitSeq();
    const remaining = new Set(unresolved);
    const found = new Map<string, Fiber>();
    yield* pass(roots, 'exact', remaining, found);
    if (remaining.size > 0) yield* pass(roots, 'derived', remaining, found);
    const stable = seq === currentCommitSeq();
    found.forEach((fiber, key) => {
      if (stable || stillShown(fiber)) settle(key, false);
    });
    if (stable) remaining.forEach((key) => settle(key, true));
  }
  return marked;
}

// 기다림이 끝나 판정을 기다리는 요청. 한 번에 모아 트리 한 번으로 판정한다.
const ready = new Set<RequestRecord>();
let roundQueued = false;

/** 판정 한 번을 큐에 올린다. 파생 색인 일을 먼저 올리고 그 뒤에서 훑는다(큐는 앞 step 이 끝나야 다음으로 넘어간다). */
const queueRound = (): void => {
  if (roundQueued) return;
  roundQueued = true;
  enqueue(() => {
    const ignored = readIgnoredEndpoints();
    const due = [...ready].filter((r) => isLive(r) && isJudgeable(r, ignored));
    ready.clear();
    if (due.length === 0) {
      roundQueued = false;
      return true;
    }
    queueIndex();
    const work = judgeRound(due);
    enqueue(() => {
      const until = performance.now() + STEP_MS;
      for (let next = work.next(); ; next = work.next()) {
        if (next.done) {
          roundQueued = false;
          if (next.value) touchRecords(); // 요청 탭·보고서가 다시 그리도록
          if (ready.size > 0) queueRound(); // 훑는 동안 기다림이 끝난 요청
          return true;
        }
        if (performance.now() >= until) return false;
      }
    }, 'analysis');
    return true;
  }, 'analysis');
};

// 본문을 받은 기록마다 한 번만 판정을 예약한다.
const scheduled = new WeakSet<RequestRecord>();

/** 기록이 바뀔 때(구독자는 유휴 큐에서 불린다) 새로 본문을 받은 요청의 판정을 UNUSED_SETTLE_MS 뒤로 예약한다. */
const scheduleNew = (): void =>
  getRecords().forEach((record) => {
    if (record.body === undefined || record.unused !== undefined || scheduled.has(record)) return;
    scheduled.add(record);
    if (!isJudgeable(record)) return; // 무시 여부는 판정할 때 본다(예약 뒤에 무시할 수 있다)
    setTimeout(() => {
      ready.add(record);
      queueRound();
    }, UNUSED_SETTLE_MS);
  });

let installed = false;

/** 쓰지 않는 응답 판정을 켠다. import 시점에 한 번 부른다(패널 없이 보고서만 쓰는 설정도 판정한다). */
export const installUnusedCheck = (): void => {
  if (installed) return;
  installed = true;
  subscribe(scheduleNew);
};
