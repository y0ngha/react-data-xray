import { requestKeyOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

const DUPLICATE_WINDOW_MS = 2000;
// 요청 기록(200건)과 달리 요청 키마다 하나씩 남으므로, 매번 URL 이 다른 앱(?_t=시각, 검색 자동완성)에서 끝없이 커지지 않게 한다.
const MAX_KEYS = 500;

/** Map 은 넣은 순서를 지키므로, 다시 넣어 맨 뒤로 보내고 넘치면 가장 오래된 키를 지운다. */
const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEYS) map.delete(map.keys().next().value as string);
};

// 모든 요청(본문 등록 여부와 무관)의 최근 기록. 중복·같은 응답 판정에 쓴다.
const lastStartByRequest = new Map<string, { id: number; startedAt: number }>();
const lastResponseByRequest = new Map<string, { id: number; text: string }>();

/** 2초 안에 같은 요청이 다시 나갔으면 앞선 요청의 id. payload 를 모르면 판정하지 않는다. */
export const detectDuplicate = (record: RequestRecord): number | undefined => {
  if (record.bodyUnreadable) return undefined;
  const key = requestKeyOf(record);
  const last = lastStartByRequest.get(key);
  remember(lastStartByRequest, key, { id: record.id, startedAt: record.startedAt });
  return last && record.startedAt - last.startedAt <= DUPLICATE_WINDOW_MS ? last.id : undefined;
};

/** 같은 요청의 직전 응답과 본문이 똑같으면 직전 요청의 id */
export const detectSameResponse = (record: RequestRecord, text: string): number | undefined => {
  if (record.bodyUnreadable) return undefined;
  const key = requestKeyOf(record);
  const last = lastResponseByRequest.get(key);
  remember(lastResponseByRequest, key, { id: record.id, text });
  return last && last.text === text ? last.id : undefined;
};

export const resetRepeatDetection = (): void => {
  lastStartByRequest.clear();
  lastResponseByRequest.clear();
};
