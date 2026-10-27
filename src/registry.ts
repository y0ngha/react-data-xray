export interface RequestRecord {
  id: number;
  method: string;
  url: string;
  status: number;
  startedAt: number;
  durationMs: number;
  body: unknown;
}

export interface Origin {
  record: RequestRecord;
  path: string;
}

const MAX_RECORDS = 200;
// 응답 하나가 아주 클 때 등록에 걸리는 시간을 막는다.
const MAX_NODES_PER_BODY = 50_000;

const origins = new WeakMap<object, Origin>();
const records: RequestRecord[] = [];
let nextId = 1;

export const createRecord = (method: string, url: string, startedAt: number): RequestRecord => ({
  id: nextId++,
  method: method.toUpperCase(),
  url,
  status: 0,
  startedAt,
  durationMs: 0,
  body: undefined,
});

/** 응답 본문의 모든 객체/배열을 출처와 함께 등록한다. 이미 등록된 객체는 처음 출처를 유지한다. */
export const registerBody = (record: RequestRecord, body: unknown): void => {
  // 폴리필의 json()이 내부에서 text() + JSON.parse 를 거치면 같은 응답이 두 번 들어온다.
  if (records.includes(record)) return;
  record.body = body;
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();

  let count = 0;
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object' || count++ > MAX_NODES_PER_BODY) return;
    if (origins.has(value)) return;
    origins.set(value, { record, path });
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else {
      for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };
  walk(body, '$');
};

export const getOrigin = (value: object): Origin | undefined => origins.get(value);

export const getRecords = (): readonly RequestRecord[] => records;

export const clearRecords = (): void => {
  records.length = 0;
};
