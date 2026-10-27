import { createRecord, finishRecord, keepResponseText, registerBody } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { isJson, isReadableText } from './contentType.js';
import { parseRawHeaders } from './headers.js';
import { rememberText } from './pendingTexts.js';
import { annotateRequest } from './requestContext.js';
import { serializeBody } from './serializeBody.js';

interface OpenedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const opened = new WeakMap<XMLHttpRequest, OpenedRequest>();
// XHR 객체를 재사용(open→send 반복)해도 리스너가 쌓이지 않도록, 리스너는 한 번만 달고 현재 요청을 따로 둔다.
const current = new WeakMap<XMLHttpRequest, RequestRecord>();
const listening = new WeakSet<XMLHttpRequest>();

const onLoad = (xhr: XMLHttpRequest): void => {
  const record = current.get(xhr);
  if (!record) return;
  record.responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
  finishRecord(record, xhr.status);
  const contentType = xhr.getResponseHeader('content-type');
  if (xhr.responseType === 'json' && xhr.response && typeof xhr.response === 'object') {
    keepResponseText(record, JSON.stringify(xhr.response), { compare: true });
    registerBody(record, xhr.response);
    return;
  }
  if (xhr.responseType !== '' && xhr.responseType !== 'text') return;
  if (isReadableText(contentType)) keepResponseText(record, xhr.responseText, { compare: isJson(contentType) });
  rememberText(xhr.responseText, record);
};

const listenOnce = (xhr: XMLHttpRequest): void => {
  if (listening.has(xhr)) return;
  listening.add(xhr);
  xhr.addEventListener('load', () => onLoad(xhr));
  // load 가 오지 않는 실패·취소·타임아웃도 목록에 남긴다.
  (['error', 'abort', 'timeout'] as const).forEach((type) =>
    xhr.addEventListener(type, () => {
      const record = current.get(xhr);
      if (record) finishRecord(record, 0, type);
    }),
  );
};

/** XMLHttpRequest(axios 등)를 감싸 요청을 기록한다. */
export const interceptXhr = (): void => {
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    opened.set(this, { method, url: String(url), headers: {} });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const request = opened.get(this);
    if (request) request.headers[name.toLowerCase()] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = opened.get(this);
    if (request) {
      const record = annotateRequest(createRecord('xhr', request.method, request.url, serializeBody(body)));
      record.requestHeaders = Object.keys(request.headers).length > 0 ? { ...request.headers } : undefined;
      current.set(this, record);
      listenOnce(this);
    }
    return originalSend.call(this, body);
  };
};
