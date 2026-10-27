import { createRecord, finishRecord, keepResponseText, registerBody } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { isJson, isReadableText } from './contentType.js';
import { headersToObject } from './headers.js';
import { rememberText } from './pendingTexts.js';
import { annotateRequest } from './requestContext.js';
import { serializeBody } from './serializeBody.js';

const responseRecords = new WeakMap<Response, RequestRecord>();

const toUrl = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

// Request 객체의 본문은 동기로 읽을 수 없다.
const requestBodyOf = (input: RequestInfo | URL, init?: RequestInit): string | null | undefined =>
  init && 'body' in init ? serializeBody(init.body) : input instanceof Request && input.body ? null : undefined;

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** fetch 를 감싸 요청을 기록하고, 응답 객체(Response)와 기록을 잇는다. */
export const interceptFetch = (): void => {
  const originalClone = Response.prototype.clone;
  const originalJson = Response.prototype.json;
  const originalText = Response.prototype.text;
  const originalFetch = window.fetch;

  // 응답 원문은 앱이 읽기 전에 복제본으로 읽는다. 스트리밍·바이너리는 붙잡지 않는다.
  const keepText = (res: Response, record: RequestRecord) => {
    const contentType = res.headers.get('content-type');
    if (!isReadableText(contentType)) return;
    originalClone
      .call(res)
      .text()
      .then((text) => keepResponseText(record, text, { compare: isJson(contentType) }))
      .catch(() => undefined);
  };

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const record = annotateRequest(createRecord('fetch', method, toUrl(input), requestBodyOf(input, init)));
    record.requestHeaders = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const res = await originalFetch.call(this, input, init).catch((e: unknown) => {
      // 실패·취소된 요청도 목록에 남기고, 앱에는 원래 에러를 그대로 던진다.
      finishRecord(record, 0, describeError(e));
      throw e;
    });
    responseRecords.set(res, record);
    record.responseHeaders = headersToObject(res.headers);
    finishRecord(record, res.status);
    keepText(res, record);
    return res;
  };

  Response.prototype.clone = function () {
    const cloned = originalClone.call(this);
    const record = responseRecords.get(this);
    if (record) responseRecords.set(cloned, record);
    return cloned;
  };

  Response.prototype.json = async function () {
    const body = await originalJson.call(this);
    const record = responseRecords.get(this);
    if (record) registerBody(record, body);
    return body;
  };

  Response.prototype.text = async function () {
    const text = await originalText.call(this);
    const record = responseRecords.get(this);
    if (record) rememberText(text, record);
    return text;
  };
};
