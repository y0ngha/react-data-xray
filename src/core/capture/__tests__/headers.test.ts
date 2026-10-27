import { describe, expect, it } from 'vitest';

import { isJson, isReadableText } from '../contentType.js';
import { headersToObject, parseRawHeaders } from '../headers.js';

describe('headers', () => {
  it('HeadersInit 을 소문자 키 객체로 바꾸고, 비었거나 잘못되면 undefined', () => {
    expect(headersToObject({ 'X-Token': 'a' })).toEqual({ 'x-token': 'a' });
    expect(headersToObject([['Accept', 'json']])).toEqual({ accept: 'json' });
    expect(headersToObject({})).toBeUndefined();
    expect(headersToObject(undefined)).toBeUndefined();
    expect(headersToObject([['bad header', 'x']])).toBeUndefined();
  });

  it('XHR 원문 헤더를 읽고 콜론 없는 줄은 버린다', () => {
    expect(parseRawHeaders('Content-Type: application/json\r\nX-Trace: a:b\r\ngarbage\r\n')).toEqual({
      'content-type': 'application/json',
      'x-trace': 'a:b',
    });
    expect(parseRawHeaders('')).toEqual({});
  });
});

describe('contentType', () => {
  it('JSON 과 텍스트 응답만 원문을 보관하고, 스트리밍은 붙잡지 않는다', () => {
    expect(isJson('application/json; charset=utf-8')).toBe(true);
    expect(isJson('application/x-ndjson')).toBe(false);
    expect(isJson(null)).toBe(false);
    expect(isReadableText('text/html')).toBe(true);
    expect(isReadableText('text/event-stream')).toBe(false);
    expect(isReadableText('image/png')).toBe(false);
    expect(isReadableText(null)).toBe(false);
  });
});
