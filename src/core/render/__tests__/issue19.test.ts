import { describe, expect, it } from 'vitest';
import { previewValue } from '../renderReason.js';

describe('previewValue 종류 표시 (#19)', () => {
  it('Map 은 크기와 앞 항목', () => {
    expect(previewValue(new Map([['a', 1]]))).toBe('Map(1) {"a" => 1}');
    expect(previewValue(new Map())).toBe('Map(0) {}');
  });
  it('Set 은 크기와 앞 항목', () => {
    expect(previewValue(new Set([1, 2, 3]))).toBe('Set(3) [1, 2, 3]');
    expect(previewValue(new Set([1, 2, 3, 4]))).toBe('Set(4) [1, 2, 3, …]');
  });
  it('재현: Map 1개 → 0개가 {} → {} 로 보이지 않는다', () => {
    expect(previewValue(new Map([['k', 'v']]))).not.toBe(previewValue(new Map()));
  });
  it('date_kind', () => {
    expect(previewValue(new Date(0))).toBe('Date(1970-01-01T00:00:00.000Z)');
  });
  it('클래스 인스턴스는 이름', () => {
    class Foo {
      x?: number;
    }
    expect(previewValue(new Foo())).toBe('Foo {}');
  });
  it('평범한 값은 그대로', () => {
    expect(previewValue({ a: 1 })).toBe('{"a":1}');
    expect(previewValue([1])).toBe('[1]');
    expect(previewValue('x')).toBe('"x"');
    expect(previewValue(null)).toBe('null');
    expect(previewValue(undefined)).toBe('undefined');
  });
});
