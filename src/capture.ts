import { compareResponseText, createRecord, finishRecord, keepResponseText, registerBody, type RequestRecord } from './registry.js';

// res.text()나 XHR 응답 문자열을 나중에 JSON.parse 하는 경우(axios 등)를 잡기 위해 잠깐 들고 있는다.
const pendingTexts = new Map<string, RequestRecord>();
const MAX_PENDING_TEXTS = 50;

const rememberText = (text: string, record: RequestRecord) => {
  pendingTexts.set(text, record);
  if (pendingTexts.size > MAX_PENDING_TEXTS) pendingTexts.delete(pendingTexts.keys().next().value!);
};

const responseRecords = new WeakMap<Response, RequestRecord>();
let installed = false;

const toUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** 요청 본문을 비교용 문자열로 바꾼다. 읽을 수 없는 본문은 null. */
export const serializeBody = (body: unknown): string | null | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((value, key) => {
      parts.push(`${key}=${typeof value === 'string' ? value : `[file ${value.name} ${value.size}B]`}`);
    });
    return parts.join('&');
  }
  return null;
};

// SSE, ndjson 처럼 오래 열려 있는 스트림을 끝까지 버퍼링하지 않도록 뺀다.
const isStreaming = (contentType: string) => /event-stream|ndjson|jsonl|stream/.test(contentType);
const isJson = (contentType: string | null) => !!contentType && contentType.includes('json') && !isStreaming(contentType);
const isReadableText = (contentType: string | null) =>
  !!contentType && !isStreaming(contentType) && /json|text|xml|javascript|x-www-form-urlencoded/.test(contentType);

const headersToObject = (headers: HeadersInit | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  try {
    const result: Record<string, string> = {};
    new Headers(headers).forEach((value, key) => {
      result[key] = value;
    });
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
};

const parseXhrHeaders = (raw: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i > 0) result[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return result;
};

export const install = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalClone = Response.prototype.clone;
  Response.prototype.clone = function () {
    const cloned = originalClone.call(this);
    const record = responseRecords.get(this);
    if (record) responseRecords.set(cloned, record);
    return cloned;
  };

  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    // Request 객체의 본문은 동기로 읽을 수 없다.
    const requestBody = init && 'body' in init ? serializeBody(init.body) : input instanceof Request && input.body ? null : undefined;
    const record = createRecord('fetch', method, toUrl(input), requestBody);
    record.requestHeaders = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let res: Response;
    try {
      res = await originalFetch.call(this, input, init);
    } catch (e) {
      // 실패·취소된 요청도 목록에 남기고, 앱에는 원래 에러를 그대로 던진다.
      finishRecord(record, 0, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      throw e;
    }
    responseRecords.set(res, record);
    record.responseHeaders = headersToObject(res.headers);
    finishRecord(record, res.status);
    // 상세 화면과 같은 응답 재요청 판정용. 스트리밍·바이너리 응답은 붙잡지 않는다.
    const contentType = res.headers.get('content-type');
    if (isReadableText(contentType)) {
      originalClone
        .call(res)
        .text()
        .then((text) => {
          keepResponseText(record, text);
          if (isJson(contentType)) compareResponseText(record, text);
        })
        .catch(() => undefined);
    }
    return res;
  };

  const originalJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const body = await originalJson.call(this);
    const record = responseRecords.get(this);
    if (record) registerBody(record, body);
    return body;
  };

  const originalText = Response.prototype.text;
  Response.prototype.text = async function () {
    const text = await originalText.call(this);
    const record = responseRecords.get(this);
    if (record) rememberText(text, record);
    return text;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrRequests = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Record<string, string> }>();
  // XHR 객체를 재사용(open→send 반복)해도 리스너가 쌓이지 않도록, 리스너는 한 번만 달고 현재 요청을 따로 둔다.
  const xhrCurrent = new WeakMap<XMLHttpRequest, RequestRecord>();
  const xhrListening = new WeakSet<XMLHttpRequest>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrRequests.set(this, { method, url: String(url), headers: {} });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const request = xhrRequests.get(this);
    if (request) request.headers[name.toLowerCase()] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = xhrRequests.get(this);
    if (request) {
      const record = createRecord('xhr', request.method, request.url, serializeBody(body));
      if (Object.keys(request.headers).length > 0) record.requestHeaders = { ...request.headers };
      xhrCurrent.set(this, record);
    }
    if (request && !xhrListening.has(this)) {
      xhrListening.add(this);
      this.addEventListener('load', () => {
        const record = xhrCurrent.get(this);
        if (!record) return;
        record.responseHeaders = parseXhrHeaders(this.getAllResponseHeaders());
        finishRecord(record, this.status);
        const contentType = this.getResponseHeader('content-type');
        if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
          const text = JSON.stringify(this.response);
          keepResponseText(record, text);
          compareResponseText(record, text);
          registerBody(record, this.response);
        } else if (this.responseType === '' || this.responseType === 'text') {
          if (isReadableText(contentType)) keepResponseText(record, this.responseText);
          if (isJson(contentType)) compareResponseText(record, this.responseText);
          rememberText(this.responseText, record);
        }
      });
      // load 가 오지 않는 실패·취소·타임아웃도 목록에 남긴다.
      for (const type of ['error', 'abort', 'timeout'] as const) {
        this.addEventListener(type, () => {
          const record = xhrCurrent.get(this);
          if (record) finishRecord(record, 0, type);
        });
      }
    }
    return originalSend.call(this, body);
  };

  const originalParse = JSON.parse;
  JSON.parse = function (text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    const result = originalParse.call(JSON, text, reviver);
    const record = typeof text === 'string' ? pendingTexts.get(text) : undefined;
    if (record) {
      pendingTexts.delete(text);
      registerBody(record, result);
    }
    return result;
  };
};
