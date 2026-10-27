import { readStored, writeStored } from '../../shared/storage.js';
import { getRecords, restoreRecords } from './store.js';
import type { RequestRecord } from './types.js';

/** 새로고침해도 요청 기록이 이어지게 탭이 닫힐 때까지(sessionStorage) 둔다. 새 탭은 빈 기록으로 시작한다. */
const RECORDS_KEY = 'react-data-xray:records';
// sessionStorage 는 출처마다 약 5MB 다. 앱이 쓸 자리를 남기고, 넘치면 오래된 기록부터 버린다.
const MAX_CHARS = 2_000_000;
// 인증 정보가 저장소에 남지 않게 값을 가린다.
const SENSITIVE_HEADER = /authorization|cookie|token|secret|api-?key|session/i;

const redact = (headers: Record<string, string> | undefined): Record<string, string> | undefined =>
  headers && Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? '(가림)' : v]));

/**
 * 저장할 모양. 응답 객체(body)는 넣지 않는다. 새로고침 뒤의 앱 객체와는 다른 객체라 출처 매칭에 쓰면 엉뚱한 답이 나오고,
 * 상세 화면은 원문(responseText, 100KB 까지)으로 보여 줄 수 있다.
 */
const toSaved = (r: RequestRecord): RequestRecord => ({
  ...r,
  body: undefined,
  requestHeaders: redact(r.requestHeaders),
  responseHeaders: redact(r.responseHeaders),
  restored: true,
});

const isRecord = (v: unknown): v is RequestRecord =>
  !!v && typeof v === 'object' && typeof (v as RequestRecord).id === 'number' && typeof (v as RequestRecord).url === 'string';

const parse = (raw: unknown): RequestRecord[] | undefined => (Array.isArray(raw) ? raw.filter(isRecord) : undefined);

/** 지금 기록을 저장한다. 크기가 넘치면 오래된 것부터 4분의 1씩 버린다. */
export const saveRecords = (): void => {
  let list = getRecords().map(toSaved);
  while (list.length > 0 && JSON.stringify(list).length > MAX_CHARS) list = list.slice(Math.ceil(list.length / 4));
  writeStored(RECORDS_KEY, list, 'session');
};

/**
 * 새로고침 전 기록을 되살리고, 페이지를 떠날 때(새로고침·이동·탭 닫기) 저장하도록 건다.
 * 중복·같은 응답 판정 기록은 되살리지 않는다. 새로고침 직후 다시 나간 요청이 "중복"으로 찍히면 안 된다.
 */
export const installSessionRecords = (): void => {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return;
  restoreRecords(readStored(RECORDS_KEY, parse, [], 'session'));
  window.addEventListener('pagehide', saveRecords);
};
