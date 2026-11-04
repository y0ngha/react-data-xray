import type { RequestRecord } from '../requests/types.js';

// 겹친 무효화(double-invalidate)에서 뒤 무효화를 부른 시각. 그때 진행 중이다가 취소된 요청은 StrictMode cleanup 의 취소가 아니다.
// React Query 점검(cacheAudit)이 유휴 큐에서 적고 요청 분류(classify)가 읽는다. 둘이 서로를 가져오면 순환하므로 따로 둔다.
const MAX_OVERLAPS = 200;
const overlaps: number[] = [];

export const noteOverlapCancel = (at: number): void => {
  overlaps.push(at);
  if (overlaps.length > MAX_OVERLAPS) overlaps.shift();
};

/** 이 요청이 진행 중일 때 겹친 무효화가 있었는가. 취소(abort)로 끝났는지는 부르는 쪽이 본다(cacheAudit 의 cancelledBy 와 같은 범위). */
export const inFlightAtOverlap = (r: RequestRecord): boolean =>
  overlaps.some((at) => r.startedAt <= at && r.startedAt + r.durationMs >= at);

export const resetOverlapCancels = (): void => {
  overlaps.length = 0;
};
