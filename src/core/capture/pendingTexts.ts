import type { RequestRecord } from '../requests/types.js';

// res.text() 나 XHR 응답 문자열을 나중에 JSON.parse 하는 경우(axios 등)를 잡기 위해 잠깐 들고 있는다.
const MAX_PENDING_TEXTS = 50;
// 원문을 Map 키로 쓰면 해시가 O(n) 이라 앱의 load 핸들러가 느려진다. 최근 것만 배열에 두고 === 로 찾는다.
const pending: { text: string; record: RequestRecord }[] = [];

/** JSON 처럼 보이는 원문만 들고 있는다. HTML·CSV 처럼 JSON.parse 할 일이 없는 큰 원문을 붙잡지 않는다. */
const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

export const rememberText = (text: string, record: RequestRecord): void => {
  if (!looksLikeJson(text)) return;
  // 같은 원문이면 가장 최근 요청이 이기도록 이전 것을 지운다(예전 Map 은 덮어썼다).
  const same = pending.findIndex((p) => p.text === text);
  if (same >= 0) pending.splice(same, 1);
  pending.push({ text, record });
  if (pending.length > MAX_PENDING_TEXTS) pending.shift();
};

/** JSON.parse 에 들어온 문자열이 최근 응답 원문이면 그 요청을 꺼낸다(한 번만). */
export const takePendingText = (text: unknown): RequestRecord | undefined => {
  if (typeof text !== 'string') return undefined;
  const i = pending.findIndex((p) => p.text === text);
  return i < 0 ? undefined : pending.splice(i, 1)[0].record;
};
