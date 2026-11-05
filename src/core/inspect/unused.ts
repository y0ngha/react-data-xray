import { currentCommitSeq } from '../render/commitCauses.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { isFailed } from '../requests/classify.js';
import { endpointOf } from '../requests/requestKey.js';
import { getRecords, subscribe, touchRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { readIgnoredEndpoints, type IgnoreMatcher } from '../../shared/ignoredEndpoints.js';
import { isOwnUi } from '../../shared/ownUi.js';
import { scanConsumers } from './consumers.js';
import { queueIndex } from './derivedMatch.js';

/**
 * 응답이 오고 이만큼 뒤에 판정한다. 응답 → setState → 렌더(React Query 는 구독자에게 알리고 다시 그림)가 끝날 시간이다.
 * 너무 짧으면 아직 그리지 않은 응답을 쓰지 않는다고 하고, 너무 길면 그 사이 화면을 떠나 쓰던 컴포넌트가 사라진다.
 */
export const UNUSED_SETTLE_MS = 3000;

// 한 step 에 쓰는 시간. fiber 하나는 대개 수 µs 라 횟수가 아니라 시간으로 끊어야 큐 조각(4ms)을 넘지 않는다(derivedMatch 와 같다).
const STEP_MS = 1;
// 훑는 사이 commit 이 트리를 바꿨는데 못 찾았으면 처음부터 다시 훑는다. 쉬지 않고 그리는 화면에서 끝없이 돌지 않게 이만큼만.
const MAX_ATTEMPTS = 3;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 출처를 참조로 찾을 수 있는 본문: 빈 객체·배열이 아닌 JSON 객체·배열 */
const hasContent = (body: unknown): boolean =>
  body !== null && typeof body === 'object' && (Array.isArray(body) ? body.length > 0 : Object.keys(body).length > 0);

/**
 * 판정할 요청인가. 변경 요청(POST 등)의 응답은 결과 확인용이라 그리지 않아도 정상이고, 실패 응답·빈 본문·JSON 이 아닌 응답(body 가 없다)은
 * 쓸 데이터가 없다. 무시한 엔드포인트(패널·configure({ ignore }))는 사용자가 의도된 요청이라고 했다(ignored 를 줄 때만 본다). 새로고침 전 기록은 응답 객체가 없어 찾을 수 없다.
 */
export const isJudgeable = (record: RequestRecord, ignored?: IgnoreMatcher): boolean =>
  !record.restored &&
  !MUTATING.has(record.method) &&
  !isFailed(record) &&
  hasContent(record.body) &&
  !ignored?.sourceOf(endpointOf(record));

/** 참조로 먼저 트리 전체를 훑고, 하나도 없을 때만 파생으로 다시 훑는다(파생은 색인 조회라 비싸다). 쓰는 컴포넌트를 찾았으면 true */
function* findsConsumer(record: RequestRecord): Generator<void, boolean, void> {
  for (const match of ['exact', 'derived'] as const) {
    for (const found of scanConsumers(record, isOwnUi, match)) {
      if (found) return true;
      yield;
    }
  }
  return false;
}

/** 판정 하나. 트리를 훑는 사이 commit 이 있었고 못 찾았으면 다시 훑는다(새로 마운트된 쪽을 못 봤을 수 있다). */
function* judge(record: RequestRecord): Generator<void, boolean, void> {
  for (let attempt = 1; ; attempt++) {
    const seq = currentCommitSeq();
    if (yield* findsConsumer(record)) return false;
    if (seq === currentCommitSeq() || attempt >= MAX_ATTEMPTS) return true;
  }
}

const isLive = (record: RequestRecord): boolean => getRecords().includes(record);

/** 판정을 큐에 올린다. 파생 색인 일을 먼저 올리고 그 뒤에서 훑는다(큐는 앞 step 이 끝나야 다음으로 넘어간다). */
const enqueueJudge = (record: RequestRecord): void =>
  enqueue(() => {
    if (!isLive(record) || !isJudgeable(record, readIgnoredEndpoints())) return true;
    queueIndex();
    const work = judge(record);
    enqueue(() => {
      // 훑는 사이 목록에서 밀려났거나 측정을 새로 시작했으면 그만둔다.
      if (!isLive(record)) return true;
      const until = performance.now() + STEP_MS;
      for (let next = work.next(); ; next = work.next()) {
        if (next.done) {
          record.unused = next.value;
          if (next.value) touchRecords(); // 요청 탭·보고서가 다시 그리도록
          return true;
        }
        if (performance.now() >= until) return false;
      }
    });
    return true;
  });

// 본문을 받은 기록마다 한 번만 판정을 예약한다.
const scheduled = new WeakSet<RequestRecord>();

/** 기록이 바뀔 때(구독자는 유휴 큐에서 불린다) 새로 본문을 받은 요청의 판정을 UNUSED_SETTLE_MS 뒤로 예약한다. */
const scheduleNew = (): void =>
  getRecords().forEach((record) => {
    if (record.body === undefined || record.unused !== undefined || scheduled.has(record)) return;
    scheduled.add(record);
    if (!isJudgeable(record)) return; // 무시 여부는 판정할 때 본다(예약 뒤에 무시할 수 있다)
    setTimeout(() => enqueueJudge(record), UNUSED_SETTLE_MS);
  });

let installed = false;

/** 쓰지 않는 응답 판정을 켠다. import 시점에 한 번 부른다(패널 없이 보고서만 쓰는 설정도 판정한다). */
export const installUnusedCheck = (): void => {
  if (installed) return;
  installed = true;
  subscribe(scheduleNew);
};
