export interface RequestRecord {
  id: number;
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  /** 요청 본문(payload)을 비교할 수 있게 문자열로 바꾼 것. 없으면 undefined */
  requestBody?: string;
  /** Blob·스트림처럼 본문을 바로 읽을 수 없어 중복·같은 응답 판정에서 뺀 요청 */
  bodyUnreadable?: boolean;
  status: number;
  startedAt: number;
  durationMs: number;
  body: unknown;
  /** 2초 안에 같은 메서드·URL·본문으로 나간 앞선 요청 */
  duplicateOf?: number;
  /** 같은 요청(메서드·URL·본문)의 직전 응답과 본문이 똑같았던 경우 */
  sameResponseAs?: number;
}

export interface Origin {
  record: RequestRecord;
  path: string;
}

const MAX_RECORDS = 200;
// 응답 하나가 아주 클 때 등록에 걸리는 시간을 막는다.
const MAX_NODES_PER_BODY = 50_000;
const DUPLICATE_WINDOW_MS = 2000;

const origins = new WeakMap<object, Origin>();
const records: RequestRecord[] = [];
// 모든 요청(본문 등록 여부와 무관)의 최근 기록. 중복·같은 응답 판정에 쓴다.
const lastByRequest = new Map<string, { id: number; startedAt: number }>();
const lastResponseByRequest = new Map<string, { id: number; text: string }>();
const listeners = new Set<() => void>();
let nextId = 1;

const notify = () => listeners.forEach((l) => l());

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** 같은 API 를 상대·절대 경로로 부른 것을 한데 모은다. 같은 출처면 경로만, 다른 출처면 호스트를 붙인다. */
export const pathOf = (url: string): string => {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
};

/** 쿼리스트링을 뺀 "메서드 경로". 엔드포인트별 집계 단위다. */
export const endpointOf = (record: Pick<RequestRecord, 'method' | 'url'>): string => `${record.method} ${pathOf(record.url)}`;

// 쿼리스트링까지 포함한 요청 단위. 중복·같은 응답 판정은 파라미터가 같은 요청끼리만 한다.
// 파라미터 순서만 다른 URL 은 같은 요청으로 본다.
const requestKeyOf = (record: Pick<RequestRecord, 'method' | 'url' | 'requestBody'>): string => {
  let url = record.url;
  try {
    const u = new URL(record.url, location.href);
    u.searchParams.sort();
    url = u.href;
  } catch {
    // URL 로 해석되지 않으면 원문으로 비교한다.
  }
  return `${record.method} ${url} ${record.requestBody ?? ''}`;
};

export const createRecord = (
  kind: RequestRecord['kind'],
  method: string,
  url: string,
  /** null 은 본문이 있지만 읽을 수 없다는 뜻이다. */
  requestBody?: string | null,
): RequestRecord => {
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
  // payload 를 모르면 같은 요청인지 알 수 없으므로 판정하지 않는다.
  if (record.bodyUnreadable) return record;
  const key = requestKeyOf(record);
  const last = lastByRequest.get(key);
  if (last && record.startedAt - last.startedAt <= DUPLICATE_WINDOW_MS) record.duplicateOf = last.id;
  lastByRequest.set(key, { id: record.id, startedAt: record.startedAt });
  return record;
};

/** 응답 본문 문자열을 같은 요청(메서드·URL·본문)의 직전 응답과 비교한다. */
export const compareResponseText = (record: RequestRecord, text: string): void => {
  if (record.bodyUnreadable) return;
  const key = requestKeyOf(record);
  const last = lastResponseByRequest.get(key);
  if (last && last.text === text) record.sameResponseAs = last.id;
  lastResponseByRequest.set(key, { id: record.id, text });
};

/** 응답이 오면 요청 목록에 넣는다. 본문을 읽지 않는 요청도 감시 대상이라 여기서 넣는다. */
export const finishRecord = (record: RequestRecord, status: number): void => {
  record.status = status;
  record.durationMs = Date.now() - record.startedAt;
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();
  notify();
};

/** 응답 본문의 모든 객체/배열을 출처와 함께 등록한다. 이미 등록된 객체는 처음 출처를 유지한다. */
export const registerBody = (record: RequestRecord, body: unknown): void => {
  // 폴리필의 json()이 내부에서 text() + JSON.parse 를 거치면 같은 응답이 두 번 들어온다.
  if (record.body !== undefined) return;
  record.body = body;

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
  notify();
};

export const getOrigin = (value: object): Origin | undefined => origins.get(value);

export const getRecords = (): readonly RequestRecord[] => records;

export const clearRecords = (): void => {
  records.length = 0;
  lastByRequest.clear();
  lastResponseByRequest.clear();
  notify();
};
