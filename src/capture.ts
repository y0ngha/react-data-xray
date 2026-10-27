import { compareResponseText, createRecord, finishRecord, registerBody, type RequestRecord } from './registry.js';

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

const isJson = (contentType: string | null) => !!contentType && contentType.includes('json');

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
    const res = await originalFetch.call(this, input, init);
    responseRecords.set(res, record);
    finishRecord(record, res.status);
    // 같은 응답 재요청 판정용. 스트리밍 응답을 붙잡지 않도록 JSON 만 본다.
    if (isJson(res.headers.get('content-type'))) {
      originalClone
        .call(res)
        .text()
        .then((text) => compareResponseText(record, text))
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
  const xhrRequests = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrRequests.set(this, { method, url: String(url) });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = xhrRequests.get(this);
    if (request) {
      const record = createRecord('xhr', request.method, request.url, serializeBody(body));
      this.addEventListener('load', () => {
        finishRecord(record, this.status);
        if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
          compareResponseText(record, JSON.stringify(this.response));
          registerBody(record, this.response);
        } else if (this.responseType === '' || this.responseType === 'text') {
          if (isJson(this.getResponseHeader('content-type'))) compareResponseText(record, this.responseText);
          rememberText(this.responseText, record);
        }
      });
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
