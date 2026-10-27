import { createRecord, registerBody, type RequestRecord } from './registry';

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

export const install = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const record = createRecord(method, toUrl(input), Date.now());
    const res = await originalFetch.call(this, input, init);
    record.status = res.status;
    record.durationMs = Date.now() - record.startedAt;
    responseRecords.set(res, record);
    return res;
  };

  const originalClone = Response.prototype.clone;
  Response.prototype.clone = function () {
    const cloned = originalClone.call(this);
    const record = responseRecords.get(this);
    if (record) responseRecords.set(cloned, record);
    return cloned;
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
  const xhrRecords = new WeakMap<XMLHttpRequest, RequestRecord>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrRecords.set(this, createRecord(method, String(url), Date.now()));
    this.addEventListener('load', () => {
      const record = xhrRecords.get(this);
      if (!record) return;
      record.status = this.status;
      record.durationMs = Date.now() - record.startedAt;
      if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
        registerBody(record, this.response);
      } else if (this.responseType === '' || this.responseType === 'text') {
        rememberText(this.responseText, record);
      }
    });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

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
