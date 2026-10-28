import { describe, expect, it } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getOrigin } from '../../requests/origins.js';
import { getRecords, subscribe } from '../../requests/store.js';

const send = (
  url: string,
  init: { method?: string; responseType?: XMLHttpRequestResponseType; header?: [string, string]; body?: string } = {},
) =>
  new Promise<XMLHttpRequest>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? 'GET', url);
    if (init.responseType) xhr.responseType = init.responseType;
    if (init.header) xhr.setRequestHeader(...init.header);
    xhr.addEventListener('loadend', () => resolve(xhr));
    xhr.send(init.body);
  });

const JSON_URL = `data:application/json,${encodeURIComponent('{"items":[{"id":11,"name":"cpu"}]}')}`;

describe('XHR 가로채기', () => {
  it('텍스트 응답을 JSON.parse 하면(axios 방식) 파싱 결과를 출처로 등록하고 원문과 헤더를 남긴다', async () => {
    const xhr = await send(JSON_URL, { method: 'POST', header: ['X-Token', 't'], body: '{"q":1}' });
    await flush();
    const parsed = JSON.parse(xhr.responseText);
    await flush();
    const [record] = getRecords();

    expect(record).toMatchObject({ kind: 'xhr', method: 'POST', status: 200, requestBody: '{"q":1}', requestHeaders: { 'x-token': 't' } });
    expect(record.responseHeaders).toMatchObject({ 'content-type': 'application/json' });
    expect(record.responseText).toContain('"cpu"');
    expect(getOrigin(parsed.items[0])?.record).toBe(record);
  });

  it('responseType 이 json 이면 응답 객체를 바로 등록한다', async () => {
    const xhr = await send(JSON_URL, { responseType: 'json' });
    await flush();
    expect(getOrigin(xhr.response)?.record.kind).toBe('xhr');
  });

  it('바이너리 응답은 원문을 남기지 않는다', async () => {
    await send(JSON_URL, { responseType: 'arraybuffer' });
    await flush();
    expect(getRecords()[0].responseText).toBeUndefined();
  });

  it('XHR 객체를 다시 써도 요청마다 한 번씩만 기록한다', async () => {
    const xhr = new XMLHttpRequest();
    const run = () =>
      new Promise<void>((resolve) => {
        xhr.open('GET', JSON_URL);
        xhr.addEventListener('loadend', () => resolve(), { once: true });
        xhr.send();
      });
    await run();
    await run();
    expect(getRecords()).toHaveLength(2);
  });

  it('취소된 요청도 기록한다', async () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', JSON_URL);
    xhr.send();
    xhr.abort();
    expect(getRecords()[0]).toMatchObject({ status: 0, error: 'abort' });
  });

  it('xhr_json_stringify_deferred: json 응답의 responseText 는 flush 뒤에 생긴다', async () => {
    await send(JSON_URL, { responseType: 'json' });
    expect(getRecords()[0].responseText).toBeUndefined();
    flushQueue();
    expect(getRecords()[0].responseText).toContain('"cpu"');
  });

  it('xhr_headers_deferred: responseHeaders 는 flush 뒤에 생긴다', async () => {
    await send(JSON_URL);
    expect(getRecords()[0].responseHeaders).toBeUndefined();
    flushQueue();
    expect(getRecords()[0].responseHeaders).toMatchObject({ 'content-type': 'application/json' });
  });

  it('xhr_headers_notify: 헤더를 붙인 뒤 구독자에게 알린다', async () => {
    await send(JSON_URL, { responseType: 'arraybuffer' });
    let seen: unknown;
    const off = subscribe(() => (seen ??= getRecords()[0].responseHeaders));
    flushQueue();
    await flush();
    off();
    expect(seen).toMatchObject({ 'content-type': 'application/json' });
  });
});
