import { describe, expect, it } from 'vitest';

import { parseIgnored } from '../../../shared/ignoredEndpoints.js';
import { classifyRecords } from '../classify.js';
import { firstOperationName, graphqlOperationOf } from '../graphqlOperation.js';
import { endpointOf } from '../requestKey.js';
import type { RequestRecord } from '../types.js';

// #77: GraphQL 은 모든 연산이 한 주소로 가므로 엔드포인트를 연산 이름으로 나눈다.
const post = (requestBody: string, url = '/graphql') => ({ method: 'POST', url, requestBody });

describe('GraphQL 연산별 엔드포인트 (#77)', () => {
  it('POST 본문의 operationName 을 붙인다', () => {
    expect(endpointOf(post('{"operationName":"GetUser","variables":{},"query":"query GetUser { me { id } }"}'))).toBe(
      'POST /graphql (GetUser)',
    );
    expect(endpointOf(post('{"operationName":"GetUser","query":"query GetUser { me { id } }"}'))).not.toBe(
      endpointOf(post('{"operationName":"GetPosts","query":"query GetPosts { posts { id } }"}')),
    );
  });

  it('operationName 이 없으면 query 의 첫 이름 있는 연산을 쓴다', () => {
    const query = '# 사용자\nfragment F on User { id }\nmutation SaveUser($query: String) { save { ...F } }';
    expect(endpointOf(post(JSON.stringify({ query })))).toBe('POST /graphql (SaveUser)');
    // 이름 없는 연산은 나누지 않는다.
    expect(endpointOf(post('{"query":"{ me { id } }"}'))).toBe('POST /graphql');
  });

  it('선택 집합 안의 query 필드나 문자열 안의 글자는 연산 머리가 아니다', () => {
    expect(firstOperationName('{ search { query foo } } query Real { x }')).toBe('Real');
    expect(firstOperationName('query Q { a(text: "mutation Fake {") }')).toBe('Q');
    expect(firstOperationName('"""query Doc { }"""\nsubscription OnMsg { m }')).toBe('OnMsg');
  });

  it('검색 API 의 query 문자열은 GraphQL 로 보지 않는다', () => {
    expect(endpointOf(post('{"query":"mutation testing"}', '/api/search'))).toBe('POST /api/search');
    expect(endpointOf(post('{"q":1}', '/api/x'))).toBe('POST /api/x');
    expect(endpointOf(post('not json', '/api/x'))).toBe('POST /api/x');
  });

  it('GET 이면 ?operationName= 이나 ?query= 를 쓴다', () => {
    expect(endpointOf({ method: 'GET', url: '/graphql?operationName=GetUser&variables=%7B%7D' })).toBe('GET /graphql (GetUser)');
    const feed = encodeURIComponent('query Feed { feed { id } }');
    expect(endpointOf({ method: 'GET', url: `/graphql?query=${feed}` })).toBe('GET /graphql (Feed)');
    expect(endpointOf({ method: 'GET', url: '/api/items?page=2' })).toBe('GET /api/items');
  });

  it('배치는 연산 이름들을 묶는다', () => {
    const batch = JSON.stringify([
      { operationName: 'GetUser', query: 'query GetUser { me { id } }' },
      { query: '{ x }' },
      { operationName: 'GetPosts' },
    ]);
    expect(endpointOf(post(batch))).toBe('POST /graphql (GetUser, GetPosts)');
    expect(endpointOf(post('[{"query":"{ x }"}, 1]'))).toBe('POST /graphql');
  });

  it('이름 없는 persisted query 는 해시 앞 8자를 쓴다(GET·POST)', () => {
    const extensions = { persistedQuery: { version: 1, sha256Hash: 'ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38' } };
    expect(endpointOf(post(JSON.stringify({ variables: {}, extensions })))).toBe('POST /graphql (persisted ecf4edb4)');
    const url = `/graphql?extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
    expect(endpointOf({ method: 'GET', url })).toBe('GET /graphql (persisted ecf4edb4)');
    // 이름이 있으면 이름을 쓴다.
    expect(endpointOf(post(JSON.stringify({ operationName: 'GetUser', extensions })))).toBe('POST /graphql (GetUser)');
    expect(endpointOf({ method: 'GET', url: '/graphql?extensions=%7Bbad' })).toBe('GET /graphql');
  });

  it('큰 본문은 통째로 파싱하지 않고 operationName 만 찾는다', () => {
    const data = 'x'.repeat(70_000);
    expect(endpointOf(post(`{"operationName":"Upload","variables":{"data":"${data}"}}`))).toBe('POST /graphql (Upload)');
    expect(endpointOf(post(`{"variables":{"data":"${data}"}}`))).toBe('POST /graphql');
  });

  it('같은 기록은 한 번만 계산한다', () => {
    const record = post('{"operationName":"GetUser"}');
    expect(graphqlOperationOf(record)).toBe('GetUser');
    record.requestBody = '{"operationName":"Other"}';
    expect(graphqlOperationOf(record)).toBe('GetUser');
    const plain = post('{}', '/api/x');
    expect(graphqlOperationOf(plain)).toBeUndefined();
    expect(graphqlOperationOf(plain)).toBeUndefined();
  });

  it('Server Action 은 연산 이름 대신 action 을 붙인다', () => {
    const call = { ...post('{"operationName":"GetUser"}', '/page'), action: '40828a5a92cb004a18' };
    expect(endpointOf(call)).toBe('POST /page (action 40828a5a)');
  });

  it('무시 목록은 연산 단위로 동작한다(저장된 키도 그대로 맞는다)', () => {
    const rec = (id: number, operationName: string, extra: Partial<RequestRecord> = {}): RequestRecord => ({
      id,
      kind: 'fetch',
      method: 'POST',
      url: '/graphql',
      requestBody: JSON.stringify({ operationName }),
      status: 200,
      startedAt: id,
      durationMs: 1,
      body: undefined,
      ...extra,
    });
    const records = [rec(1, 'GetUser'), rec(2, 'GetUser', { duplicateOf: 1 }), rec(3, 'GetPosts'), rec(4, 'GetPosts', { duplicateOf: 3 })];
    const ignored = parseIgnored(['POST /graphql (GetUser)']) ?? new Set<string>();
    expect(ignored).toEqual(new Set(['POST /graphql (GetUser)']));
    const classes = classifyRecords(records, ignored);
    expect(classes.get(2)).toBe('ignored');
    expect(classes.get(4)).not.toBe('ignored');
  });
});
