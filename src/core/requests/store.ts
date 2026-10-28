import { enqueue } from '../scheduler/idleQueue.js';
import { registerOrigins } from './origins.js';
import { repeatCauseStep } from './repeatCause.js';
import { detectDuplicate, detectSameResponse, resetRepeatDetection } from './repeatDetection.js';
import type { RequestRecord } from './types.js';

const MAX_RECORDS = 200;
const MAX_RESPONSE_TEXT = 100_000;

const records: RequestRecord[] = [];
const listeners = new Set<() => void>();
let nextId = 1;
// 이 id 보다 앞선 요청은 측정을 새로 시작(clearRecords)하기 전에 나간 것이라, 늦게 끝나도 넣지 않는다.
let firstLiveId = 1;
/** 지금까지 시작한 마지막 요청의 id. 같은 밀리초 안에서도 어느 일이 어느 요청 시작 뒤인지 가른다. */
export const lastRecordId = (): number => nextId - 1;
// 기록 상한을 넘어 버린 요청 수(측정을 새로 시작하면 0). 보고서가 수치가 잘렸는지 알린다.
let dropped = 0;

export const getDroppedCount = (): number => dropped;
const isStale = (record: RequestRecord): boolean => record.id < firstLiveId;
// 같은 탭에서 몇 번째로 연 페이지인지(세션 유지가 정한다). 기록마다 붙인다.
let currentLoad = 0;

export const setCurrentLoad = (load: number): void => {
  currentLoad = load;
};

// 기록이 바뀔 때마다 오른다. 기록에서 계산한 값을 다시 계산할지 판단할 때 쓴다.
let version = 0;

// 구독자 호출은 한 번에 묶어 큐에서 부른다(앱의 호출 경로에서 렌더를 일으키지 않는다).
let notifyQueued = false;
const notify = () => {
  version++;
  if (notifyQueued) return;
  notifyQueued = true;
  enqueue(() => {
    notifyQueued = false;
    listeners.forEach((listener) => listener());
    return true;
  });
};

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getRecords = (): readonly RequestRecord[] => records;

export const getStoreVersion = (): number => version;

/** 기록의 내용을 나중에 채웠을 때(원본 위치 등) 구독자에게 알린다. */
export const touchRecords = (): void => notify();

/** 요청이 나갈 때 만든다. requestBody 가 null 이면 본문이 있지만 읽을 수 없다는 뜻이다. */
export const createRecord = (
  kind: RequestRecord['kind'],
  method: string,
  url: string,
  requestBody?: string | null,
  action?: string,
): RequestRecord => {
  const record: RequestRecord = {
    id: nextId++,
    load: currentLoad,
    kind,
    method: method.toUpperCase(),
    url,
    requestBody: requestBody ?? undefined,
    action,
    bodyUnreadable: requestBody === null || undefined,
    status: 0,
    startedAt: Date.now(),
    durationMs: 0,
    body: undefined,
  };
  // 순서는 큐가 지키고, 판정은 startedAt 기준이라 늦어도 같다.
  enqueue(() => {
    if (!isStale(record)) record.duplicateOf = detectDuplicate(record);
    // 보낸 컴포넌트는 앞서 걸린 annotate step 이 채우므로, 그 뒤로 한 번 더 미룬다.
    if (record.duplicateOf) {
      const step = repeatCauseStep(record);
      enqueue(() => {
        const done = step();
        if (done && record.repeatCause) notify(); // 요청 탭·상세가 다시 그리도록
        return done;
      });
    }
    return true;
  });
  return record;
};

/** 응답이 오면 목록에 넣는다. 본문을 읽지 않는 요청과 실패한 요청도 감시 대상이다. */
export const finishRecord = (record: RequestRecord, status: number, error?: string): void => {
  record.status = status;
  record.error = error;
  record.durationMs = Date.now() - record.startedAt;
  if (isStale(record)) return;
  records.push(record);
  if (records.length > MAX_RECORDS) {
    records.shift();
    dropped++;
  }
  notify();
};

/** 응답 원문을 상세 화면용으로 보관하고, 같은 요청의 직전 응답과 비교한다. */
export const keepResponseText = (record: RequestRecord, text: string, { compare }: { compare: boolean }): void => {
  enqueue(() => {
    if (isStale(record)) return true;
    record.responseText = text.length > MAX_RESPONSE_TEXT ? `${text.slice(0, MAX_RESPONSE_TEXT)}\n… (100KB 이후 생략)` : text;
    if (compare) record.sameResponseAs = detectSameResponse(record, text);
    notify();
    return true;
  });
};

/** 파싱된 응답 본문을 보관하고 그 안의 객체들을 출처와 함께 등록한다. */
export const registerBody = (record: RequestRecord, body: unknown): void => {
  // 폴리필의 json() 이 내부에서 text() + JSON.parse 를 거치면 같은 응답이 두 번 들어온다.
  if (record.body !== undefined || isStale(record)) return;
  record.body = body;
  registerOrigins(record, body);
  notify();
};

/**
 * 다른 페이지(새로고침 전, 또는 bfcache 로 돌아오기 전에 간 페이지)의 기록을 합친다. 이미 있는 id 는 건너뛴다.
 * 새 요청의 id 가 합친 것보다 크도록 이어서 매긴다(최신 응답을 고르는 규칙이 id 에 기댄다).
 */
export const mergeRecords = (others: readonly RequestRecord[]): void => {
  const known = new Set(records.map((r) => r.id));
  const added = others.filter((r) => !known.has(r.id));
  if (added.length === 0) return;
  const merged = [...records, ...added].sort((a, b) => a.id - b.id).slice(-MAX_RECORDS);
  records.splice(0, records.length, ...merged);
  nextId = Math.max(nextId, ...added.map((r) => r.id + 1));
  notify();
};

export const clearRecords = (): void => {
  records.length = 0;
  firstLiveId = nextId;
  dropped = 0;
  resetRepeatDetection();
  notify();
};
