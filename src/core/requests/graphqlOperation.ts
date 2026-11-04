import { parseUrl } from '../../shared/format.js';

/**
 * GraphQL 요청의 연산 이름. 모든 연산이 `POST /graphql` 한 주소로 가므로, 엔드포인트를 연산마다 나누는 데 쓴다.
 *
 * 앱 경로에서는 부르지 않는다(집계·화면에서 부른다). 같은 기록을 화면이 다시 그릴 때마다 부르므로 기록마다 한 번만 계산한다.
 *
 * GraphQL 로 보는 것은 본문(또는 GET 쿼리)에 GraphQL 문서 모양의 `query` 가 있거나, `extensions.persistedQuery` 가 있거나,
 * 경로에 `graphql` 이 들어 있을 때뿐이다. `POST /api/track` 의 `{"operationName":"click"}` 처럼 이름만 같은 필드로는 나누지 않는다.
 */

// 화면에 보일 persisted query 해시 길이(전체는 64자)
const HASH_LENGTH = 8;
// 이보다 큰 본문은 통째로 파싱하지 않고 문자열에서 찾는다(업로드처럼 variables 가 큰 요청).
const MAX_PARSE_LENGTH = 64_000;
const NAME = /^[A-Za-z_]\w*$/;
// 문자열·블록 문자열·주석. 이 안의 중괄호나 'query X' 를 연산 머리로 읽지 않게 지운다.
const IGNORED_TOKENS = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*/g;
const OPERATION_HEAD = /[{}]|(?<![\w$])(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/g;
// GraphQL 문서의 첫머리(주석 뒤): 연산·fragment 정의나 이름 없는 연산의 선택 집합
const DOCUMENT_START = /^(?:\s|#[^\n]*\n)*(?:\{|(?:query|mutation|subscription|fragment)[\s({])/;
// 큰 본문(JSON 원문)에서 찾는 것. 문자열 안의 줄바꿈은 `\n` 두 글자로 들어 있다.
const JSON_SPACE = String.raw`(?:\\[nrt]|\s)`;
const RAW_NAMES = new RegExp(
  String.raw`"operationName"\s*:\s*"([A-Za-z_]\w*)"|"query"\s*:\s*"${JSON_SPACE}*(?:query|mutation|subscription)${JSON_SPACE}+([A-Za-z_]\w*)`,
  'g',
);
const RAW_DOCUMENT = new RegExp(
  String.raw`"query"\s*:\s*"${JSON_SPACE}*(?:\{|(?:query|mutation|subscription|fragment)(?:${JSON_SPACE}|[({]))`,
);
const RAW_HASH = /"persistedQuery"\s*:\s*\{[^}]*?"sha256Hash"\s*:\s*"([0-9a-fA-F]+)"/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 문서에서 첫 번째 이름 있는 연산. 중괄호 밖(최상위)의 머리만 본다. 선택 집합 안의 `query foo` 필드는 연산이 아니다.
 * 머리 뒤에 선택 집합(`{`)이 없으면 GraphQL 이 아니다(검색 API 의 `{"query":"mutation testing"}` 같은 본문).
 */
export const firstOperationName = (document: string): string | undefined => {
  const source = document.replace(IGNORED_TOKENS, '""');
  let depth = 0;
  for (const m of source.matchAll(OPERATION_HEAD)) {
    if (m[0] === '{') depth++;
    else if (m[0] === '}') depth--;
    else if (depth === 0) return source.includes('{', m.index) ? m[1] : undefined;
  }
  return undefined;
};

const looksLikeDocument = (query: unknown): query is string =>
  typeof query === 'string' && DOCUMENT_START.test(query) && query.includes('{');

const persistedHashOf = (extensions: unknown): string | undefined => {
  const persisted = isObject(extensions) ? extensions.persistedQuery : undefined;
  const hash = isObject(persisted) ? persisted.sha256Hash : undefined;
  return typeof hash === 'string' && hash !== '' ? hash : undefined;
};

const persistedLabel = (hash: string): string => `persisted ${hash.slice(0, HASH_LENGTH)}`;

type Operation = { operationName?: unknown; query?: unknown; extensions?: unknown };

/** 한 연산(본문 객체 또는 GET 쿼리)의 이름. 이름이 없고 persisted query 면 해시 앞부분. GraphQL 이 아니면 undefined */
const nameOf = (operation: Operation, graphqlPath: boolean): string | undefined => {
  const { operationName, query } = operation;
  const hash = persistedHashOf(operation.extensions);
  const document = looksLikeDocument(query);
  if (!graphqlPath && !document && !hash) return undefined;
  if (typeof operationName === 'string' && NAME.test(operationName)) return operationName;
  const fromQuery = document ? firstOperationName(query) : undefined;
  if (fromQuery) return fromQuery;
  return hash ? persistedLabel(hash) : undefined;
};

/** 이름들을 처음 나온 순서로 하나씩만 묶는다(배치). */
const joinNames = (names: ReadonlyArray<string | undefined>): string | undefined => {
  const unique = [...new Set(names.filter((n): n is string => n !== undefined))];
  return unique.length ? unique.join(', ') : undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * 큰 본문은 파싱하지 않고 원문에서 `"operationName":"X"` 와 `"query":"query X …"` 를 모두 찾아 작은 본문(배치)과 같게 묶는다.
 * variables 안에 operationName 이라는 키가 있으면 그 값도 이름으로 잡히지만 드물어 받아들인다.
 */
const fromRawJson = (body: string, graphqlPath: boolean): string | undefined => {
  if (!graphqlPath && !RAW_DOCUMENT.test(body) && !body.includes('"persistedQuery"')) return undefined;
  const names = joinNames(Array.from(body.matchAll(RAW_NAMES), (m) => m[1] ?? m[2]));
  return names ?? joinNames(Array.from(body.matchAll(RAW_HASH), (m) => persistedLabel(m[1])));
};

const fromJson = (body: string, graphqlPath: boolean): string | undefined => {
  if (body.length > MAX_PARSE_LENGTH) return fromRawJson(body, graphqlPath);
  const parsed = parseJson(body);
  if (isObject(parsed)) return nameOf(parsed, graphqlPath);
  // 배치: 연산 이름들을 묶는다. 이름을 모르는 연산은 뺀다.
  return Array.isArray(parsed) ? joinNames(parsed.filter(isObject).map((op) => nameOf(op, graphqlPath))) : undefined;
};

// GraphQL multipart 업로드(apollo-upload-client)의 FormData 는 `operations=<JSON>&map=<JSON>&0=[file …]` 로 기록된다.
const OPERATIONS_FIELD = 'operations=';
const MAP_FIELD = '&map=';

const fromBody = (body: string, graphqlPath: boolean): string | undefined => {
  if (!body.startsWith(OPERATIONS_FIELD)) return fromJson(body, graphqlPath);
  const end = body.indexOf(MAP_FIELD);
  return fromJson(body.slice(OPERATIONS_FIELD.length, end < 0 ? undefined : end), graphqlPath);
};

const fromQueryString = (url: URL | null, graphqlPath: boolean): string | undefined => {
  const params = url?.searchParams;
  if (!params || !(params.has('operationName') || params.has('query') || params.has('extensions'))) return undefined;
  const extensions = params.get('extensions');
  return nameOf(
    {
      operationName: params.get('operationName') ?? undefined,
      query: params.get('query') ?? undefined,
      extensions: extensions === null ? undefined : parseJson(extensions),
    },
    graphqlPath,
  );
};

type GraphqlRequest = { url: string; requestBody?: string };

const cache = new WeakMap<GraphqlRequest, string | null>();

/** 요청이 GraphQL 연산이면 그 이름(배치면 쉼표로 묶은 이름들). 아니면 undefined */
export const graphqlOperationOf = (record: GraphqlRequest): string | undefined => {
  const cached = cache.get(record);
  if (cached !== undefined) return cached ?? undefined;
  const url = parseUrl(record.url);
  const graphqlPath = /graphql/i.test(url?.pathname ?? record.url.split('?')[0]);
  const name =
    (record.requestBody === undefined ? undefined : fromBody(record.requestBody, graphqlPath)) ?? fromQueryString(url, graphqlPath);
  cache.set(record, name ?? null);
  return name;
};
