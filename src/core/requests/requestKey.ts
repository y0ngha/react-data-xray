import { parseUrl } from '../../shared/format.js';
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

/** 쿼리스트링을 빼고 경로 안의 ID 를 ':id' 로 묶은 "메서드 경로". 엔드포인트별 집계 단위다. 원래 URL 은 레코드에 그대로 있다. */
export const endpointOf = (record: Pick<RequestRecord, 'method' | 'url' | 'action'>): string =>
  `${record.method} ${maskIds(pathOf(record.url))}${actionSuffix(record.action)}`;

/**
 * 쿼리스트링과 payload 까지 포함한 요청 단위. 중복·같은 응답 판정은 같은 요청끼리만 한다.
 * 파라미터 순서만 다른 URL 은 같은 요청으로 본다.
 */
export const requestKeyOf = (record: Pick<RequestRecord, 'method' | 'url' | 'requestBody' | 'action'>): string => {
  const u = parseUrl(record.url);
  u?.searchParams.sort();
  // 같은 요청인지는 이름을 알기 전후로 바뀌면 안 되므로 id 그대로 쓴다.
  return `${record.method} ${u?.href ?? record.url}${record.action ? ` ${record.action}` : ''} ${record.requestBody ?? ''}`;
};
