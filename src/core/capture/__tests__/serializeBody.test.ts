import { describe, expect, it } from 'vitest';

import { serializeBody } from '../serializeBody.js';

describe('serializeBody', () => {
  it('문자열, URLSearchParams, FormData(파일은 이름·크기)는 내용으로 바꾼다', () => {
    const form = new FormData();
    form.append('name', 'cpu');
    form.append('file', new File(['abc'], 'a.txt'));
    expect(serializeBody('{"a":1}')).toBe('{"a":1}');
    expect(serializeBody(new URLSearchParams({ a: '1' }))).toBe('a=1');
    expect(serializeBody(form)).toBe('name=cpu&file=[file a.txt 3B]');
  });

  it('본문이 없으면 undefined, 읽을 수 없는 본문(Blob 등)은 null', () => {
    expect(serializeBody(undefined)).toBeUndefined();
    expect(serializeBody(null)).toBeUndefined();
    expect(serializeBody(new Blob(['x']))).toBeNull();
    expect(serializeBody(new ArrayBuffer(2))).toBeNull();
  });
});
