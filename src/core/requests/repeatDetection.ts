import { requestKeyOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

const DUPLICATE_WINDOW_MS = 2000;

// 모든 요청(본문 등록 여부와 무관)의 최근 기록. 중복·같은 응답 판정에 쓴다.
const lastStartByRequest = new Map<string, { id: number; startedAt: number }>();
const lastResponseByRequest = new Map<string, { id: number; text: string }>();

/** 2초 안에 같은 요청이 다시 나갔으면 앞선 요청의 id. payload 를 모르면 판정하지 않는다. */
export const detectDuplicate = (record: RequestRecord): number | undefined => {
  if (record.bodyUnreadable) return undefined;
  const key = requestKeyOf(record);
  const last = lastStartByRequest.get(key);
  lastStartByRequest.set(key, { id: record.id, startedAt: record.startedAt });
  return last && record.startedAt - last.startedAt <= DUPLICATE_WINDOW_MS ? last.id : undefined;
};

/** 같은 요청의 직전 응답과 본문이 똑같으면 직전 요청의 id */
export const detectSameResponse = (record: RequestRecord, text: string): number | undefined => {
  if (record.bodyUnreadable) return undefined;
  const key = requestKeyOf(record);
  const last = lastResponseByRequest.get(key);
  lastResponseByRequest.set(key, { id: record.id, text });
  return last && last.text === text ? last.id : undefined;
};

export const resetRepeatDetection = (): void => {
  lastStartByRequest.clear();
  lastResponseByRequest.clear();
};
