import type { RequestRecord } from '../requests/types.js';

/** 쿼리 재조회 원인. 같은 응답을 다시 받았을 때 낭비인지 의도인지 가르는 근거다. */
export type RefetchReason = 'stale-elapsed' | 'stale-zero' | 'after-invalidate';

/** 'none': 쿼리 성공과 맞춰 봤지만 원인이 없다고 확정한 것(아직 모르는 것과 가른다) */
const pinned = new WeakMap<RequestRecord, RefetchReason | 'none'>();

export const isPinned = (record: RequestRecord): boolean => pinned.has(record);

export const pinReason = (record: RequestRecord, reason: RefetchReason | 'none'): void => void pinned.set(record, reason);

/** 유휴 큐가 고정해 둔 원인만 읽는다(렌더·분류 중에는 계산하지 않는다). 아직 모르거나 원인이 없으면 undefined. */
export const pinnedRefetchReason = (record: RequestRecord): RefetchReason | undefined => {
  const reason = pinned.get(record);
  return reason === 'none' ? undefined : reason;
};
