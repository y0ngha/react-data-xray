import { parseUrl } from '../../shared/format.js';

/**
 * GraphQL 요청의 연산 이름. 모든 연산이 `POST /graphql` 한 주소로 가므로, 엔드포인트를 연산마다 나누는 데 쓴다.
 *
 * 앱 경로에서는 부르지 않는다(집계·화면에서 부른다). 같은 기록을 화면이 다시 그릴 때마다 부르므로 기록마다 한 번만 계산한다.
 */

// 화면에 보일 persisted query 해시 길이(전체는 64자)
const HASH_LENGTH = 8;
// 이보다 큰 본문은 통째로 파싱하지 않고 operationName 만 찾는다(업로드처럼 variables 가 큰 요청).
const MAX_PARSE_LENGTH = 64_000;
const NAME = /^[A-Za-z_]\w*$/;
// 큰 본문에서 찾는 `"operationName":"GetUser"`. variables 안에 같은 키가 있으면 틀릴 수 있지만 드물다.
const OPERATION_NAME_FIELD = /"operationName"\s*:\s*"([A-Za-z_]\w*)"/;
// 문자열·블록 문자열·주석. 이 안의 중괄호나 'query X' 를 연산 머리로 읽지 않게 지운다.
const IGNORED_TOKENS = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*/g;
const OPERATION_HEAD = /[{}]|(?<![\w$])(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/g;

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

const persistedHashOf = (extensions: unknown): string | undefined => {
  const persisted = isObject(extensions) ? extensions.persistedQuery : undefined;
  const hash = isObject(persisted) ? persisted.sha256Hash : undefined;
  return typeof hash === 'string' && hash !== '' ? hash : undefined;
};

/** 한 연산(본문 객체 또는 GET 쿼리)의 이름. 이름이 없고 persisted query 면 해시 앞부분. GraphQL 이 아니면 undefined */
const nameOf = (operation: { operationName?: unknown; query?: unknown; extensions?: unknown }): string | undefined => {
  const { operationName, query } = operation;
  if (typeof operationName === 'string' && NAME.test(operationName)) return operationName;
  const fromQuery = typeof query === 'string' ? firstOperationName(query) : undefined;
  if (fromQuery) return fromQuery;
  const hash = persistedHashOf(operation.extensions);
  return hash ? `persisted ${hash.slice(0, HASH_LENGTH)}` : undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const fromBody = (body: string): string | undefined => {
  if (body.length > MAX_PARSE_LENGTH) return OPERATION_NAME_FIELD.exec(body)?.[1];
  const parsed = parseJson(body);
  if (isObject(parsed)) return nameOf(parsed);
  if (!Array.isArray(parsed)) return undefined;
  // 배치: 연산 이름들을 묶는다. 이름을 모르는 연산은 뺀다.
  const names = parsed
    .filter(isObject)
    .map(nameOf)
    .filter((n): n is string => n !== undefined);
  return names.length ? names.join(', ') : undefined;
};

const fromQueryString = (url: string): string | undefined => {
  const params = parseUrl(url)?.searchParams;
  if (!params || !(params.has('operationName') || params.has('query') || params.has('extensions'))) return undefined;
  const extensions = params.get('extensions');
  return nameOf({
    operationName: params.get('operationName') ?? undefined,
    query: params.get('query') ?? undefined,
    extensions: extensions === null ? undefined : parseJson(extensions),
  });
};

type GraphqlRequest = { url: string; requestBody?: string };

const cache = new WeakMap<GraphqlRequest, string | null>();

/** 요청이 GraphQL 연산이면 그 이름(배치면 쉼표로 묶은 이름들). 아니면 undefined */
export const graphqlOperationOf = (record: GraphqlRequest): string | undefined => {
  const cached = cache.get(record);
  if (cached !== undefined) return cached ?? undefined;
  const name = (record.requestBody === undefined ? undefined : fromBody(record.requestBody)) ?? fromQueryString(record.url);
  cache.set(record, name ?? null);
  return name;
};
