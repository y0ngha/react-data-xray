import { createRecord, finishRecord, keepResponseText, registerBody, touchRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { attempt } from './attempt.js';
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
  finishRecord(record, xhr.status);
  const contentType = xhr.getResponseHeader('content-type');
  const rawHeaders = xhr.getAllResponseHeaders();
  const isObject = xhr.responseType === 'json' && xhr.response && typeof xhr.response === 'object';
  const readable = xhr.responseType === '' || xhr.responseType === 'text';
  const response: unknown = isObject ? xhr.response : undefined;
  const text = readable ? xhr.responseText : undefined;
  if (isObject) registerBody(record, response);
  else if (text !== undefined) rememberText(text, record);
  // 헤더 파싱·직렬화·원문 보관은 O(n) 이라 앱의 load 핸들러 안에서 하지 않는다.
  enqueue(() => {
    attempt(() => {
      record.responseHeaders = parseRawHeaders(rawHeaders);
      // shortcut: 앱이 load 핸들러에서 응답 객체를 고치면 고친 값으로 비교한다, 오판이 보이면 원문(responseText) 기반으로 바꾼다.
      if (isObject) keepResponseText(record, JSON.stringify(response), { compare: true });
      else if (text !== undefined && isReadableText(contentType)) keepResponseText(record, text, { compare: isJson(contentType) });
    });
    touchRecords(); // finishRecord 의 알림은 이 step 보다 먼저라, 열려 있는 상세가 헤더를 보려면 한 번 더 알린다.
    return true;
  });
};

const listenOnce = (xhr: XMLHttpRequest): void => {
  if (listening.has(xhr)) return;
  listening.add(xhr);
  xhr.addEventListener('load', () => attempt(() => onLoad(xhr)));
  // load 가 오지 않는 실패·취소·타임아웃도 목록에 남긴다.
  (['error', 'abort', 'timeout'] as const).forEach((type) =>
    xhr.addEventListener(type, () =>
      attempt(() => {
        const record = current.get(xhr);
        if (record) finishRecord(record, 0, type);
      }),
    ),
  );
};

/** XMLHttpRequest(axios 등)를 감싸 요청을 기록한다. */
export const interceptXhr = (): void => {
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    attempt(() => opened.set(this, { method, url: String(url), headers: {} }));
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    attempt(() => {
      const request = opened.get(this);
      if (request) request.headers[name.toLowerCase()] = value;
    });
    return originalSetRequestHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    attempt(() => {
      current.delete(this);
      const request = opened.get(this);
      if (!request) return;
      const record = annotateRequest(createRecord('xhr', request.method, request.url, serializeBody(body)));
      record.requestHeaders = Object.keys(request.headers).length > 0 ? { ...request.headers } : undefined;
      current.set(this, record);
      listenOnce(this);
    });
    return originalSend.call(this, body);
  };
};
