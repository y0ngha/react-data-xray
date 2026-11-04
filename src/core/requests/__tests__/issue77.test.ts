import { describe, expect, it } from 'vitest';

import type { ComparableReport } from '../../report/compare.js';
import { compare } from '../../report/compare.js';
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
    expect(firstOperationName('query Q')).toBeUndefined();
    expect(firstOperationName('{ a }')).toBeUndefined();
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

  it('큰 본문은 통째로 파싱하지 않아도 작은 본문과 같은 엔드포인트가 된다', () => {
    const data = 'x'.repeat(70_000);
    const same = (body: object, url = '/graphql') => {
      const small = endpointOf(post(JSON.stringify(body), url));
      const big = endpointOf(post(JSON.stringify(Array.isArray(body) ? body : { ...body, variables: { data } }), url));
      expect(big).toBe(small);
      return big;
    };
    expect(same({ operationName: 'Upload', query: 'mutation Upload { up }' })).toBe('POST /graphql (Upload)');
    expect(same({ query: '\n  query Feed($n: Int) { feed { id } }' }, '/api/gql')).toBe('POST /api/gql (Feed)');
    const batch = [
      { operationName: 'GetUser', query: 'query GetUser { me { id } }' },
      { operationName: 'GetPosts', query: 'query GetPosts { posts { id } }', variables: { data } },
      { operationName: 'GetUser', query: 'query GetUser { me { id } }' },
    ];
    expect(same(batch)).toBe('POST /graphql (GetUser, GetPosts)');
    const extensions = { persistedQuery: { version: 1, sha256Hash: 'ecf4edb46db40b5132295c0291d62fb6' } };
    expect(same({ extensions }, '/api/q')).toBe('POST /api/q (persisted ecf4edb4)');
    expect(same({ operationName: 'Track', event: 'click' }, '/api/track')).toBe('POST /api/track');
    expect(endpointOf(post(`{"variables":{"data":"${data}"}}`))).toBe('POST /graphql');
  });

  it('GraphQL 문서·persisted query·graphql 경로가 아니면 operationName 만으로 나누지 않는다', () => {
    expect(endpointOf(post('{"operationName":"click","target":"buy"}', '/api/track'))).toBe('POST /api/track');
    expect(endpointOf({ method: 'GET', url: '/api/track?operationName=click' })).toBe('GET /api/track');
    expect(endpointOf(post('{"operationName":"GetUser"}', '/api/GraphQL'))).toBe('POST /api/GraphQL (GetUser)');
    expect(endpointOf(post('{"operationName":"GetUser","query":"query GetUser { me }"}', '/api/q'))).toBe('POST /api/q (GetUser)');
  });

  it('multipart 업로드(FormData 의 operations 필드)에서도 연산 이름을 찾는다', () => {
    const operations = JSON.stringify({ operationName: 'UploadFile', query: 'mutation UploadFile($f: Upload!) { upload(file: $f) }' });
    const body = `operations=${operations}&map={"0":["variables.f"]}&0=[file a.png 12B]`;
    expect(endpointOf(post(body, '/api/q'))).toBe('POST /api/q (UploadFile)');
    expect(endpointOf(post(`operations=${operations}`, '/api/q'))).toBe('POST /api/q (UploadFile)');
    expect(endpointOf(post('name=a&file=[file a.png 12B]', '/api/upload'))).toBe('POST /api/upload');
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

  it('compare: 한쪽은 POST /graphql 한 줄, 다른 쪽은 연산별이면 이름 규칙이 바뀌었다고 알린다', () => {
    const report = (...endpoints: string[]): ComparableReport => ({
      requests: { endpoints: endpoints.map((endpoint) => ({ endpoint, count: 1, duplicates: 0, sameResponses: 0 })) },
      renders: { monitoring: true, windowSeconds: 10, components: [] },
      reactQuery: { findings: [] },
    });
    const old = report('POST /graphql', 'GET /api/x');
    const split = report('POST /graphql (GetUser)', 'POST /graphql (GetPosts)', 'GET /api/x');
    const warning = expect.stringContaining('endpoint naming changed for POST /graphql');
    expect(compare(old, split).warnings).toEqual([warning]);
    expect(compare(split, old).warnings).toEqual([warning]);
    expect(compare(split, split).warnings).toEqual([]);
    expect(compare(report('POST /graphql', 'POST /graphql (GetUser)'), split).warnings).toEqual([]);
  });
});
