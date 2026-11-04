import { requestKeyOf } from './requestKey.js';
import { sameDigest, type ResponseDigest } from './responseHash.js';
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
const lastStartByRequest = new Map<string, { id: number; startedAt: number; commitSeq?: number }>();
// 응답 원문 대신 길이·해시만 남긴다(#65). 원문을 두면 큰 응답 × 500키가 그대로 힙에 남는다.
const lastResponseByRequest = new Map<string, { id: number; digest: ResponseDigest }>();

const charsIn = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object' || value === null) return 0;
  return Object.values(value).reduce((n: number, v) => n + charsIn(v), 0);
};

/**
 * 같은 응답 판정이 붙들고 있는 메모리 진단: 요청 키 수와, 남긴 값 안의 문자열 글자 수(원문을 남기지 않으므로 0 이어야 한다).
 * 자가 점검(#76 doctor)이 판정용 메모리가 키 수에 비례하는 작은 크기인지 확인할 때 쓴다.
 */
export const sameResponseMemory = (): { keys: number; retainedChars: number } => ({
  keys: lastResponseByRequest.size,
  retainedChars: [...lastResponseByRequest.values()].reduce((n, entry) => n + charsIn(entry), 0),
});

/** 2초 안에 같은 요청이 다시 나갔으면 앞선 요청(id 와 그 요청을 만들 때의 commit 순번). payload 를 모르면 판정하지 않는다. */
export const detectDuplicate = (record: RequestRecord): { id: number; commitSeq?: number } | undefined => {
  if (record.bodyUnreadable) return undefined;
  const key = requestKeyOf(record);
  const last = lastStartByRequest.get(key);
  remember(lastStartByRequest, key, { id: record.id, startedAt: record.startedAt, commitSeq: record.commitSeq });
  return last && record.startedAt - last.startedAt <= DUPLICATE_WINDOW_MS ? { id: last.id, commitSeq: last.commitSeq } : undefined;
};

/** 같은 요청의 직전 응답과 본문(길이·해시)이 똑같으면 직전 요청의 id */
export const detectSameResponse = (record: RequestRecord, digest: ResponseDigest): number | undefined => {
  if (record.bodyUnreadable) return undefined;
  const key = requestKeyOf(record);
  const last = lastResponseByRequest.get(key);
  remember(lastResponseByRequest, key, { id: record.id, digest });
  return last && sameDigest(last.digest, digest) ? last.id : undefined;
};

export const resetRepeatDetection = (): void => {
  lastStartByRequest.clear();
  lastResponseByRequest.clear();
};
