import { readStored, writeStored } from '../../shared/storage.js';

const RESET_AT_KEY = 'rdx:resetAt';

/** 이 탭에서 마지막으로 reset 한 시각(콘솔의 reset() 도 반영된다) */
export const getResetAt = (): number | null =>
  readStored<number | null>(RESET_AT_KEY, (v) => (typeof v === 'number' ? v : undefined), null, 'session');

export const writeResetAt = (t: number): void => writeStored(RESET_AT_KEY, t, 'session');
