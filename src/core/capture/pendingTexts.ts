import type { RequestRecord } from '../requests/types.js';

// res.text() 나 XHR 응답 문자열을 나중에 JSON.parse 하는 경우(axios 등)를 잡기 위해 잠깐 들고 있는다.
const MAX_PENDING_TEXTS = 50;
const pending = new Map<string, RequestRecord>();

/** JSON 처럼 보이는 원문만 들고 있는다. HTML·CSV 처럼 JSON.parse 할 일이 없는 큰 원문을 붙잡지 않는다. */
const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

export const rememberText = (text: string, record: RequestRecord): void => {
  if (!looksLikeJson(text)) return;
  pending.set(text, record);
  if (pending.size > MAX_PENDING_TEXTS) pending.delete(pending.keys().next().value as string);
};

/** JSON.parse 에 들어온 문자열이 최근 응답 원문이면 그 요청을 꺼낸다(한 번만). */
export const takePendingText = (text: unknown): RequestRecord | undefined => {
  if (typeof text !== 'string') return undefined;
  const record = pending.get(text);
  pending.delete(text);
  return record;
};
