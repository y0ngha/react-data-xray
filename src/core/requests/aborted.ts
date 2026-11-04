import type { RequestRecord } from './types.js';

/** 취소(abort)로 끝난 요청. 분류(classify)와 겹친 무효화 판정(reactQuery/overlapCancel)이 함께 쓴다. */
export const isAborted = (record: RequestRecord | undefined): boolean => !!record?.error && /abort/i.test(record.error);
