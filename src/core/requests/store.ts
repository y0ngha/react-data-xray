import { registerOrigins } from './origins.js';
import { detectDuplicate, detectSameResponse, resetRepeatDetection } from './repeatDetection.js';
import type { RequestRecord } from './types.js';

const MAX_RECORDS = 200;
const MAX_RESPONSE_TEXT = 100_000;

const records: RequestRecord[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

// 기록이 바뀔 때마다 오른다. 기록에서 계산한 값을 다시 계산할지 판단할 때 쓴다.
let version = 0;

const notify = () => {
  version++;
  listeners.forEach((listener) => listener());
};

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getRecords = (): readonly RequestRecord[] => records;

export const getStoreVersion = (): number => version;

/** 요청이 나갈 때 만든다. requestBody 가 null 이면 본문이 있지만 읽을 수 없다는 뜻이다. */
export const createRecord = (kind: RequestRecord['kind'], method: string, url: string, requestBody?: string | null): RequestRecord => {
  const record: RequestRecord = {
    id: nextId++,
    kind,
    method: method.toUpperCase(),
    url,
    requestBody: requestBody ?? undefined,
    bodyUnreadable: requestBody === null || undefined,
    status: 0,
    startedAt: Date.now(),
    durationMs: 0,
    body: undefined,
  };
  record.duplicateOf = detectDuplicate(record);
  return record;
};

/** 응답이 오면 목록에 넣는다. 본문을 읽지 않는 요청과 실패한 요청도 감시 대상이다. */
export const finishRecord = (record: RequestRecord, status: number, error?: string): void => {
  record.status = status;
  record.error = error;
  record.durationMs = Date.now() - record.startedAt;
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();
  notify();
};

/** 응답 원문을 상세 화면용으로 보관하고, 같은 요청의 직전 응답과 비교한다. */
export const keepResponseText = (record: RequestRecord, text: string, { compare }: { compare: boolean }): void => {
  record.responseText = text.length > MAX_RESPONSE_TEXT ? `${text.slice(0, MAX_RESPONSE_TEXT)}\n… (100KB 이후 생략)` : text;
  if (compare) record.sameResponseAs = detectSameResponse(record, text);
  notify();
};

/** 파싱된 응답 본문을 보관하고 그 안의 객체들을 출처와 함께 등록한다. */
export const registerBody = (record: RequestRecord, body: unknown): void => {
  // 폴리필의 json() 이 내부에서 text() + JSON.parse 를 거치면 같은 응답이 두 번 들어온다.
  if (record.body !== undefined) return;
  record.body = body;
  registerOrigins(record, body);
  notify();
};

/**
 * 새로고침 전 페이지의 기록을 앞에 되살린다. 앱 요청보다 먼저(설치할 때) 부른다.
 * 새 요청의 id 가 되살린 것보다 크도록 이어서 매긴다(최신 응답을 고르는 규칙이 id 에 기댄다).
 */
export const restoreRecords = (restored: readonly RequestRecord[]): void => {
  if (restored.length === 0) return;
  records.unshift(...restored.slice(-MAX_RECORDS));
  records.splice(MAX_RECORDS);
  nextId = Math.max(nextId, ...restored.map((r) => r.id + 1));
  notify();
};

export const clearRecords = (): void => {
  records.length = 0;
  resetRepeatDetection();
  notify();
};
