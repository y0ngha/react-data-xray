import { describe, expect, it } from 'vitest';

import { DEFAULT_BODY, flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { installCapture } from '../install.js';
import { getOrigin } from '../../requests/origins.js';
import { getRecords } from '../../requests/store.js';

describe('fetch 가로채기', () => {
  it('요청·응답 헤더, payload, 응답 원문을 기록하고 json() 결과를 출처로 등록한다', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DEFAULT_BODY, { headers: { 'x-trace': 'abc' } }));
    const body = await fetch('/api/item?id=7', { method: 'post', headers: { 'X-Token': 't1' }, body: '{"id":7}' }).then((r) => r.json());
    await flush();

    const [record] = getRecords();
    expect(record).toMatchObject({
      kind: 'fetch',
      method: 'POST',
      status: 200,
      requestBody: '{"id":7}',
      requestHeaders: { 'x-token': 't1' },
    });
    expect(record.responseHeaders).toMatchObject({ 'x-trace': 'abc' });
    expect(record.responseText).toBe(JSON.stringify(DEFAULT_BODY));
    expect(getOrigin(body.data.list[1])).toEqual({ record, path: '$.data.list[1]' });
  });

  it('res.text() 뒤 JSON.parse 해도(axios 방식) 파싱 결과를 출처로 등록하고, 상관없는 JSON.parse 는 건드리지 않는다', async () => {
    const text = await fetch('/api/text').then((r) => r.text());
    const parsed = JSON.parse(text);
    const unrelated = JSON.parse('{"x":1}', (_k, v) => v);

    expect(getOrigin(parsed)?.record.url).toBe('/api/text');
    expect(getOrigin(unrelated)).toBeUndefined();
  });

  it('clone() 한 응답도 같은 요청으로 이어진다', async () => {
    const res = await fetch('/api/clone');
    const body = await res.clone().json();
    expect(getOrigin(body)?.record.url).toBe('/api/clone');
  });

  it('실패한 요청은 기록하고 앱에는 원래 에러를 던진다', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetch('/api/down')).rejects.toThrow('Failed to fetch');
    mockFetch.mockRejectedValueOnce('offline');
    await expect(fetch('/api/down2')).rejects.toBe('offline');
    expect(getRecords().map((r) => r.error)).toEqual(['TypeError: Failed to fetch', 'offline']);
  });

  it('Request 객체로 보낸 요청은 메서드·헤더를 읽고, 본문은 읽을 수 없는 것으로 둔다', async () => {
    await fetch(new Request('http://localhost/api/req', { method: 'PUT', body: 'x', headers: { 'X-A': '1' } }));
    expect(getRecords()[0]).toMatchObject({
      method: 'PUT',
      bodyUnreadable: true,
      requestHeaders: { 'x-a': '1', 'content-type': 'text/plain;charset=UTF-8' },
    });
  });

  it('URL 객체로 보낸 요청도 기록한다', async () => {
    await fetch(new URL('http://localhost/api/url'));
    expect(getRecords()[0].url).toBe('http://localhost/api/url');
  });

  it('스트리밍·바이너리 응답은 원문을 붙잡지 않는다', async () => {
    mockFetch.mockResolvedValueOnce(new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await fetch('/api/sse');
    await flush();
    expect(getRecords()[0].responseText).toBeUndefined();
  });

  it('설치는 한 번만 한다', () => {
    const wrapped = window.fetch;
    installCapture();
    expect(window.fetch).toBe(wrapped);
  });
});
