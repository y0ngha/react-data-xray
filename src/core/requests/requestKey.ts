import { parseUrl } from '../../shared/format.js';
import { graphqlOperationOf } from './graphqlOperation.js';
import { actionNameOf } from './serverActionNames.js';
import type { RequestRecord } from './types.js';

/** 같은 API 를 상대·절대 경로로 부른 것을 한데 모은다. 같은 출처면 경로만, 다른 출처면 호스트를 붙인다. */
export const pathOf = (url: string): string => {
  const u = parseUrl(url);
  if (!u) return url.split('?')[0];
  return u.origin === location.origin ? u.pathname : `${u.host}${u.pathname}`;
};

// 화면에 보일 Server Action id 길이(전체는 40자 남짓)
const ACTION_ID_LENGTH = 8;

/** Server Action 이면 어느 함수인지 붙인다(이름을 알면 이름, 아니면 id 앞부분). 같은 페이지 경로의 서로 다른 함수를 나눠 센다. */
const actionSuffix = (action: string | undefined): string =>
  action ? ` (${actionNameOf(action) ?? `action ${action.slice(0, ACTION_ID_LENGTH)}`})` : '';

const ID_SEGMENT_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  // 'usr_8f3a9c2d' 처럼 구분자가 있는 접두사형은 8자부터, 'grp0a1b…' 처럼 붙은 접두사형은 24자부터 ID 로 본다.
  /^[a-z]+[_-](?=[0-9a-f]*\d)[0-9a-f]{8,}$/i,
  /^[a-z]+[0-9a-f]{24,}$/i,
];

/** 경로 조각이 숫자·UUID·긴 16진수·접두사형 ID 면 ':id' 로 바꾼다. 'v2'·'members' 같은 조각은 그대로 둔다. */
const maskIds = (path: string): string =>
  path
    .split('/')
    .map((segment) => (ID_SEGMENT_PATTERNS.some((re) => re.test(segment)) ? ':id' : segment))
    .join('/');

/** GraphQL 이면 연산 이름을 붙인다. 모든 연산이 한 주소(`POST /graphql`)로 가므로 이것이 없으면 엔드포인트 단위 기능이 GraphQL 전체를 한 줄로 뭉갠다. */
const operationSuffix = (record: Pick<RequestRecord, 'url' | 'requestBody'>): string => {
  const operation = graphqlOperationOf(record);
  return operation ? ` (${operation})` : '';
};

/**
 * 쿼리스트링을 빼고 경로 안의 ID 를 ':id' 로 묶은 "메서드 경로". 엔드포인트별 집계 단위다. 원래 URL 은 레코드에 그대로 있다.
 * Server Action 이면 함수, GraphQL 이면 연산 이름을 괄호로 붙인다(무시 목록도 이 단위로 맞춘다).
 */
export const endpointOf = (record: Pick<RequestRecord, 'method' | 'url' | 'action' | 'requestBody'>): string =>
  `${record.method} ${maskIds(pathOf(record.url))}${record.action ? actionSuffix(record.action) : operationSuffix(record)}`;

/** ID 묶기가 생기기 전에 저장한 엔드포인트("GET /items/5")를 지금 형식("GET /items/:id")으로 바꾼다. 이미 묶인 것은 그대로다. */
export const maskEndpoint = (endpoint: string): string =>
  endpoint.replace(/^(\S+ )(\S+)/, (_, method: string, path: string) => method + maskIds(path));

// 요청 시작 시각과 이만큼 안쪽이면 그 시각으로 만든 값으로 본다. cache-buster 는 보내기 직전의 Date.now() 라 좁게 잡는다.
// 폴링의 `since=<직전 조회 시각>` 처럼 주기만큼 앞선 시각은 진짜 조건이므로 키에 남는다.
const CACHE_BUSTER_WINDOW_MS = 2000;
const EPOCH_MS = /^\d{13}$/;
const EPOCH_S = /^\d{10}(?:\.\d+)?$/;

const isNowStamp = (value: string, startedAt: number): boolean => {
  const ms = EPOCH_MS.test(value) ? Number(value) : EPOCH_S.test(value) ? Number(value) * 1000 : NaN;
  return Math.abs(ms - startedAt) <= CACHE_BUSTER_WINDOW_MS;
};

type UrlInput = Pick<RequestRecord, 'url'> & Partial<Pick<RequestRecord, 'startedAt'>>;
type KeyInput = Pick<RequestRecord, 'method' | 'url' | 'requestBody' | 'action'> & Partial<Pick<RequestRecord, 'startedAt'>>;

/** URL 을 한 번 읽어 cache-buster 인 (이름, 값) 짝과 나머지로 가른다. 요청 시각을 모르면 아무것도 빼지 않는다. */
const splitCacheBusters = ({ url, startedAt }: UrlInput): { url: URL; kept: Array<[string, string]>; busters: string[] } | undefined => {
  const parsed = parseUrl(url);
  if (!parsed) return undefined;
  const kept: Array<[string, string]> = [];
  const busters = new Set<string>();
  for (const [name, value] of parsed.searchParams) {
    if (startedAt !== undefined && isNowStamp(value, startedAt)) busters.add(name);
    else kept.push([name, value]);
  }
  return { url: parsed, kept, busters: [...busters] };
};

/**
 * 캐시를 피하려고 요청마다 현재 시각을 붙인 쿼리 파라미터(`?_t=1730700000000`, jQuery 의 `?_=…`) 이름.
 * 이름이 아니라 값이 요청 시작 시각의 epoch(ms·초)인지로 가린다. 같은 이름의 진짜 파라미터를 빼지 않기 위해서다.
 */
export const cacheBusterParams = (record: UrlInput): string[] => splitCacheBusters(record)?.busters ?? [];

/**
 * 쿼리스트링과 payload 까지 포함한 요청 단위. 중복·같은 응답 판정은 같은 요청끼리만 한다.
 * 파라미터 순서만 다른 URL 은 같은 요청으로 본다. 값이 현재 시각인 cache-buster 짝은 뺀다(매 요청이 다른 요청이 된다).
 * 같은 이름이라도 값이 시각이 아닌 짝은 남긴다.
 */
export const requestKeyOf = (record: KeyInput): string => {
  const split = splitCacheBusters(record);
  if (split) {
    const params = new URLSearchParams(split.kept);
    params.sort();
    split.url.search = params.toString();
  }
  // 같은 요청인지는 이름을 알기 전후로 바뀌면 안 되므로 id 그대로 쓴다.
  return `${record.method} ${split?.url.href ?? record.url}${record.action ? ` ${record.action}` : ''} ${record.requestBody ?? ''}`;
};
