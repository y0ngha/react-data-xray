import { isAborted } from '../requests/aborted.js';
import type { RequestRecord } from '../requests/types.js';

/**
 * 겹친 무효화(double-invalidate) 하나. at 은 뒤 무효화를 부른 시각, fetchStarts 는 두 무효화가 함께 덮어 다시 받은 쿼리들이
 * 앞 무효화 뒤에 시작한 fetch 시각이다(뒤 무효화가 취소한 재조회가 이 중에 있다).
 * React Query 점검(cacheAudit)이 유휴 큐에서 적고, 점검 결과·요청 상세·요청 분류(classify)가 모두 아래 cancelledBy 로 읽는다.
 * 그래서 세 화면이 같은 요청을 가리킨다. cacheAudit 가 classify 를 가져오므로 classify 가 cacheAudit 를 가져오면 순환해 따로 둔다.
 */
export interface Overlap {
  at: number;
  fetchStarts: readonly number[];
}

// 쿼리의 fetch 시작에서 요청이 나가기까지 걸리는 시간의 상한(cacheAudit 의 fetchStartOf 와 같은 범위)
const FETCH_TO_REQUEST_MS = 1000;
const MAX_OVERLAPS = 200;
const overlaps: Overlap[] = [];

export const noteOverlap = (overlap: Overlap): void => {
  overlaps.push(overlap);
  if (overlaps.length > MAX_OVERLAPS) overlaps.shift();
};

/** 이 겹친 무효화가 취소한 요청인가: 취소로 끝났고, 뒤 무효화 시각에 진행 중이었고, 두 무효화가 덮은 쿼리의 fetch 가 보낸 요청이다. */
export const cancelledBy = (overlap: Overlap, r: RequestRecord): boolean =>
  isAborted(r) &&
  r.startedAt <= overlap.at &&
  r.startedAt + r.durationMs >= overlap.at &&
  overlap.fetchStarts.some((f) => f <= r.startedAt + 5 && r.startedAt - f <= FETCH_TO_REQUEST_MS);

/** 어느 겹친 무효화든 이 요청을 취소했는가(요청 분류용) */
export const cancelledByOverlap = (r: RequestRecord): boolean => overlaps.some((o) => cancelledBy(o, r));

export const resetOverlaps = (): void => {
  overlaps.length = 0;
};
