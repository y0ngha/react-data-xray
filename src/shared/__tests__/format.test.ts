import { describe, expect, it } from 'vitest';

import { clamp, formatJson, prettyText, queryOf, queryParamsOf, truncate, valueAt } from '../format.js';

describe('format', () => {
  it('truncate 는 길이를 넘을 때만 줄임표를 붙인다', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcd', 3)).toBe('abc…');
  });

  it('formatJson 은 직렬화할 수 없는 값도 문자열로 보여 준다', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatJson({ a: 1 })).toBe('{"a":1}');
    expect(formatJson(undefined)).toBe('undefined');
    expect(formatJson(circular)).toBe('[object Object]');
    expect(formatJson('x'.repeat(200), 5)).toBe('"xxxx…');
  });

  it('prettyText 는 JSON 이면 들여쓰고 아니면 그대로 둔다', () => {
    expect(prettyText('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyText('plain')).toBe('plain');
  });

  it('valueAt 은 배열 인덱스와 필드 경로를 따라가고, 없는 경로는 undefined', () => {
    const body = { data: { list: [{ title: 'a' }, { title: 'b' }] } };
    expect(valueAt(body, '$.data.list[1].title')).toBe('b');
    expect(valueAt(body, '$')).toBe(body);
    expect(valueAt(body, '$.data.missing.deep')).toBeUndefined();
  });

  it('queryOf, queryParamsOf 는 쿼리를 읽고 같은 이름은 쉼표로 잇는다', () => {
    expect(queryOf('/api?a=1')).toBe('?a=1');
    expect(queryOf('/api')).toBe('');
    expect(queryParamsOf('/api?a=1&b=2&a=3')).toEqual({ a: '1, 3', b: '2' });
    expect(queryParamsOf('http://[bad')).toBeUndefined();
    expect(queryOf('http://[bad')).toBe('');
  });

  it('clamp 는 범위 안으로 자른다', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
