import { isAborted } from '../requests/aborted.js';
import type { RequestRecord } from '../requests/types.js';

/**
 * 겹친 무효화(double-invalidate) 하나. at 은 뒤 무효화를 부른 시각, fetchStarts 는 두 무효화가 함께 덮어 다시 받은 쿼리들이
 * 앞 무효화 뒤에 시작한 fetch 시각이다(뒤 무효화가 취소한 재조회가 이 중에 있다).
 * React Query 점검(cacheAudit)이 유휴 큐에서 적는다. 점검 결과·요청 상세는 아래 cancelledBy 로 찾고, 요청 분류는 그 판정을
 * 기록에 담은 값(cancelledByOverlap)만 읽는다. 그래서 세 화면이 같은 요청을 가리킨다.
 * cacheAudit 가 classify 를 가져오므로 classify 쪽에서 쓰는 것은 cacheAudit 를 거치지 않게 따로 둔다.
 */
export interface Overlap {
  at: number;
  fetchStarts: readonly number[];
}

/** 쿼리의 fetch 시작(또는 무효화)에서 요청이 나가기까지 걸리는 시간의 상한 */
export const FETCH_TO_REQUEST_MS = 1000;
/** 요청 시각이 fetch 시작보다 조금 앞서 찍힐 수 있는 여유(같은 밀리초 안의 순서) */
export const START_SLACK_MS = 5;

/** 이 요청이 at 에 시작한 fetch(또는 무효화)가 보낸 요청일 수 있는가 */
export const sentAfter = (at: number, r: RequestRecord): boolean =>
  at <= r.startedAt + START_SLACK_MS && r.startedAt - at <= FETCH_TO_REQUEST_MS;

const MAX_OVERLAPS = 200;
const overlaps: Overlap[] = [];

/** 이 겹친 무효화가 취소한 요청인가: 취소로 끝났고, 뒤 무효화 시각에 진행 중이었고, 두 무효화가 덮은 쿼리의 fetch 가 보낸 요청이다. */
export const cancelledBy = (overlap: Overlap, r: RequestRecord): boolean =>
  isAborted(r) && r.startedAt <= overlap.at && r.startedAt + r.durationMs >= overlap.at && overlap.fetchStarts.some((f) => sentAfter(f, r));

/** 겹침을 적고, 이미 끝난 요청 중 이 겹침이 취소한 것에 표시한다. 유휴 큐에서 부른다. 표시한 것이 있으면 true. */
export const noteOverlap = (overlap: Overlap, records: readonly RequestRecord[]): boolean => {
  overlaps.push(overlap);
  if (overlaps.length > MAX_OVERLAPS) overlaps.shift();
  let marked = false;
  records.forEach((r) => {
    if (!r.cancelledByOverlap && cancelledBy(overlap, r)) marked = r.cancelledByOverlap = true;
  });
  return marked;
};

/** 겹침 판정 뒤에 끝난 요청: 앞서 적힌 겹침이 취소한 것이면 표시한다. 유휴 큐에서 부른다. 표시했으면 true. */
export const markOverlapCancelled = (r: RequestRecord): boolean => {
  if (r.cancelledByOverlap || !overlaps.some((o) => cancelledBy(o, r))) return false;
  r.cancelledByOverlap = true;
  return true;
};

export const resetOverlaps = (): void => {
  overlaps.length = 0;
};
