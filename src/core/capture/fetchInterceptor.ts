import { actionNameOf, learnActionNames } from '../requests/serverActionNames.js';
import { createRecord, finishRecord, keepResponseText, registerBody } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { isJson, isReadableText } from './contentType.js';
import { headersToObject } from './headers.js';
import { rememberText } from './pendingTexts.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { attempt } from './attempt.js';
import { annotateRequest } from './requestContext.js';
import { requestOrigin } from './requestOrigins.js';
import { serializeBody } from './serializeBody.js';

const responseRecords = new WeakMap<Response, RequestRecord>();

const toUrl = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

// Request 객체의 본문은 동기로 읽을 수 없다.
const requestBodyOf = (input: RequestInfo | URL, init?: RequestInit): string | null | undefined =>
  init && 'body' in init ? serializeBody(init.body) : input instanceof Request && input.body ? null : undefined;

// 프레임워크 dev 서버의 자체 요청(Next.js dev overlay 가 오류 위치를 묻는 /__nextjs_original-stack-frames 등). 앱 요청이 아니다.
const FRAMEWORK_INTERNAL_PATH = /^\/__nextjs_/;

const isFrameworkInternal = (url: string): boolean => {
  try {
    return FRAMEWORK_INTERNAL_PATH.test(new URL(url, location.href).pathname);
  } catch {
    return false;
  }
};

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** 요청이 나갈 때 기록을 만든다. */
const startRecord = (input: RequestInfo | URL, init?: RequestInit): RequestRecord => {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const requestHeaders = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const action = requestHeaders?.['next-action'];
  const record = annotateRequest(createRecord('fetch', method, toUrl(input), requestBodyOf(input, init), action), requestOrigin(input));
  // 처음 보는 Server Action 이면 함수 이름을 찾아 둔다(받아 둔 스크립트를 한 번씩만 읽는다).
  if (action && !actionNameOf(action)) void learnActionNames();
  record.requestHeaders = requestHeaders;
  return record;
};

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
    if (isFrameworkInternal(toUrl(input))) return originalFetch.call(this, input, init);
    const record = attempt(() => startRecord(input, init));
    if (!record) return originalFetch.call(this, input, init);
    const res = await originalFetch.call(this, input, init).catch((e: unknown) => {
      // 실패·취소된 요청도 목록에 남기고, 앱에는 원래 에러를 그대로 던진다.
      attempt(() => finishRecord(record, 0, describeError(e)));
      throw e;
    });
    attempt(() => {
      responseRecords.set(res, record);
      enqueue(() => {
        attempt(() => (record.responseHeaders = headersToObject(res.headers)));
        return true;
      });
      finishRecord(record, res.status);
      keepText(res, record);
    });
    return res;
  };

  Response.prototype.clone = function () {
    const cloned = originalClone.call(this);
    attempt(() => {
      const record = responseRecords.get(this);
      if (record) responseRecords.set(cloned, record);
    });
    return cloned;
  };

  Response.prototype.json = async function () {
    const body = await originalJson.call(this);
    attempt(() => {
      const record = responseRecords.get(this);
      if (record) registerBody(record, body);
    });
    return body;
  };

  Response.prototype.text = async function () {
    const text = await originalText.call(this);
    attempt(() => {
      const record = responseRecords.get(this);
      if (record) rememberText(text, record);
    });
    return text;
  };
};
