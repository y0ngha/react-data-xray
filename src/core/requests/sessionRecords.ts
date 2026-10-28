import { flushQueue } from '../scheduler/idleQueue.js';
import { readStored, writeStored } from '../../shared/storage.js';
import { getRecords, mergeRecords, setCurrentLoad } from './store.js';
import type { RequestRecord } from './types.js';

/** 새로고침해도 요청 기록이 이어지게 탭이 닫힐 때까지(sessionStorage) 둔다. 새 탭은 빈 기록으로 시작한다. */
const RECORDS_KEY = 'react-data-xray:records';
/** 이 탭에서 몇 번째로 연 페이지인지. 기록마다 붙여 주기 판정을 페이지 안에서만 한다. */
const LOAD_KEY = 'react-data-xray:load';
// sessionStorage 는 출처마다 약 5MB 를 앱과 나눠 쓴다. 앱의 저장이 넘치지 않게 작게 쓴다.
const MAX_CHARS = 500_000;
// 상세 화면에서 "새로고침 전" 기록은 앞부분만 봐도 충분하다.
const MAX_TEXT = 10_000;
// 인증 정보가 저장소에 남지 않게 가린다(헤더 이름, 본문·쿼리의 키).
const SENSITIVE = /authorization|cookie|token|secret|password|passwd|pwd|api-?_?key|session/i;
const SENSITIVE_IN_TEXT = /"[^"]*(token|secret|password|passwd|pwd|api_?key|authorization)[^"]*"\s*:/i;
const HIDDEN = '(가림)';

const redactHeaders = (headers: Record<string, string> | undefined): Record<string, string> | undefined =>
  headers && Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE.test(k) ? HIDDEN : v]));

/** 비밀값 키가 보이는 본문은 통째로 가리고, 아니면 앞부분만 남긴다. */
const redactText = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  if (SENSITIVE_IN_TEXT.test(text)) return HIDDEN;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (새로고침 전 기록은 10KB 까지만 남깁니다)` : text;
};

/** 쿼리에서 비밀값 이름의 값을 가린다(?token=…). */
export const redactUrl = (url: string): string =>
  url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (all, sep: string, name: string) => (SENSITIVE.test(name) ? `${sep}${name}=${HIDDEN}` : all));

/**
 * 저장할 모양. 응답 객체(body)는 넣지 않는다. 새로고침 뒤의 앱 객체와는 다른 객체라 출처 매칭에 쓰면 엉뚱한 답이 나오고,
 * 상세 화면은 원문 앞부분으로 보여 줄 수 있다.
 */
const toSaved = (r: RequestRecord): RequestRecord => ({
  ...r,
  url: redactUrl(r.url),
  body: undefined,
  requestBody: redactText(r.requestBody),
  responseText: redactText(r.responseText),
  requestHeaders: redactHeaders(r.requestHeaders),
  responseHeaders: redactHeaders(r.responseHeaders),
  restored: true,
});

const isRecord = (v: unknown): v is RequestRecord => {
  const r = v as Partial<RequestRecord> | null;
  return (
    !!r &&
    typeof r.id === 'number' &&
    typeof r.url === 'string' &&
    typeof r.method === 'string' &&
    typeof r.status === 'number' &&
    typeof r.startedAt === 'number' &&
    typeof r.durationMs === 'number'
  );
};

const parse = (raw: unknown): RequestRecord[] | undefined => (Array.isArray(raw) ? raw.filter(isRecord) : undefined);

/** 지금 기록을 저장한다. 최신 기록부터 크기를 더해 상한 안에 드는 만큼만, 직렬화는 한 번만 한다. */
export const saveRecords = (): void => {
  flushQueue(200); // 미뤄 둔 원문·중복 판정이 빠진 채 저장되지 않게
  const saved = getRecords().map(toSaved);
  let size = 2;
  let from = saved.length;
  while (from > 0) {
    const next = JSON.stringify(saved[from - 1]).length + 1;
    if (size + next > MAX_CHARS) break;
    size += next;
    from--;
  }
  writeStored(RECORDS_KEY, saved.slice(from), 'session');
};

/** 저장해 둔 기록을 합치고 저장소에서 지운다. 페이지가 살아 있는 동안 자리를 차지하지 않고, 저장에 실패해도 오래된 기록이 되살아나지 않는다. */
const takeSaved = (): void => {
  mergeRecords(readStored(RECORDS_KEY, parse, [], 'session'));
  try {
    sessionStorage.removeItem(RECORDS_KEY);
  } catch {
    // 저장소를 못 쓰면 넘어간다.
  }
};

/**
 * 새로고침 전 기록을 되살리고, 페이지를 떠날 때(새로고침·이동·탭 닫기) 저장하도록 건다.
 * - 중복·같은 응답 판정 기록은 되살리지 않는다. 새로고침 직후 다시 나간 요청이 "중복"으로 찍히면 안 된다.
 * - bfcache 로 이 페이지가 되돌아오면, 그사이 다른 페이지가 저장한 기록을 합친다(뒤 페이지의 기록을 잃지 않게).
 */
export const installSessionRecords = (): void => {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return;
  const load = readStored(LOAD_KEY, (v) => (typeof v === 'number' ? v : undefined), 0, 'session') + 1;
  writeStored(LOAD_KEY, load, 'session');
  setCurrentLoad(load);
  takeSaved();
  window.addEventListener('pagehide', saveRecords);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) takeSaved();
  });
};
