import { describe, expect, it } from 'vitest';

import { clearRecords, createRecord, finishRecord, registerBody } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';

/** 응답을 받은 요청처럼 목록에 넣고 본문을 등록한다. */
const respond = (url: string, body: unknown): RequestRecord => {
  const record = createRecord('fetch', 'GET', url);
  finishRecord(record, 200);
  registerBody(record, body);
  return record;
};
import { findDerivedOrigin } from '../derivedMatch.js';
import { findExactOrigins, isSameOrChildPath } from '../exactMatch.js';
import { mergeHits } from '../mergeHits.js';
import { guessByText } from '../textMatch.js';
import type { Hit } from '../types.js';

describe('exactMatch', () => {
  it('경로 포함 관계는 경계까지 비교한다', () => {
    expect(isSameOrChildPath('$.a[1].b', '$.a[1]')).toBe(true);
    expect(isSameOrChildPath('$.a[10]', '$.a[1]')).toBe(false);
    expect(isSameOrChildPath('$.ab', '$.a')).toBe(false);
  });

  it('React element 는 props 만 따라가고 DOM 노드와 순환 참조는 건너뛴다', () => {
    const record = createRecord('fetch', 'GET', '/api/e');
    const body = { item: { id: 1 } };
    registerBody(record, body);
    const circular: Record<string, unknown> = { node: document.createElement('div') };
    circular.self = circular;
    const element = { $$typeof: Symbol.for('react.element'), props: { item: body.item }, _owner: circular };
    const { hits } = findExactOrigins({ element, circular }, 'props');
    expect(hits).toEqual([expect.objectContaining({ path: '$.item', via: 'props.element.props.item' })]);
  });
});

describe('derivedMatch', () => {
  it('가장 많이 겹치는 응답 객체를 고르고, 같은 점수면 최신 응답을 고른다', () => {
    const old = respond('/api/old', { user: { id: 1001, name: 'kim', team: 'ops' } });
    const latest = respond('/api/new', { user: { id: 1001, name: 'kim', team: 'dev' } });
    expect(findDerivedOrigin({ id: 1001, name: 'kim', extra: true })?.record).toBe(latest);
    expect(findDerivedOrigin({ id: 1001, name: 'kim', team: 'ops' })?.record).toBe(old);
    expect(findDerivedOrigin({ id: 1, flag: true })).toBeNull();
  });

  it('작은 숫자뿐인 응답을 펼쳐 복사하고 필드를 덧붙여도, 원시값 필드 묶음과 값이 모두 같으면 찾는다', () => {
    const summary = respond('/api/summary', { total: 3, normal: 2, paused: 0, os: { linux: 3 } });
    const copy = { ...(summary.body as object), before: { total: 2 } };
    expect(findDerivedOrigin(copy)).toEqual({ record: summary, path: '$' });
    expect(findDerivedOrigin({ total: 3, normal: 1, paused: 0 })).toBeNull();
    expect(findDerivedOrigin({ total: 3, normal: 2 })).toBeNull();
  });

  it('새 응답은 색인에 더하고, 목록에서 빠진 응답은 찾지 않는다', () => {
    respond('/api/gone', { user: { id: 2002, name: 'lee' } });
    expect(findDerivedOrigin({ id: 2002, name: 'lee' })).not.toBeNull();
    clearRecords();
    expect(findDerivedOrigin({ id: 2002, name: 'lee' })).toBeNull();
    const added = respond('/api/added', { user: { id: 3003, name: 'park' } });
    expect(findDerivedOrigin({ id: 3003, name: 'park' })?.record).toBe(added);
  });
});

describe('mergeHits', () => {
  it('같은 응답 항목의 하위 경로는 한 줄로 묶고, 다른 항목은 따로 둔다', () => {
    const record = createRecord('fetch', 'GET', '/api/m');
    const hit = (path: string, via: string): Hit => ({ record, path, via, match: 'exact' });
    expect(mergeHits([hit('$.list[0].a', 'props.a'), hit('$.list[0].b', 'props.b'), hit('$.list[1]', 'props.c')])).toEqual([
      hit('$.list[0]', 'props.a, props.b'),
      hit('$.list[1]', 'props.c'),
    ]);
  });
});

describe('textMatch', () => {
  it('비었거나 너무 긴 글자는 찾지 않는다', () => {
    expect(guessByText('   ')).toEqual([]);
    expect(guessByText('x'.repeat(201))).toEqual([]);
  });

  it('최근 응답부터 같은 값을 찾는다', () => {
    const record = respond('/api/t', { list: [{ count: 42 }, null] });
    expect(guessByText(' 42 ')).toEqual([{ record, path: '$.list[0].count', via: 'text', match: 'text' }]);
  });
});
