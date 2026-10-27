import { parseUrl } from '../../shared/format.js';
import type { RequestRecord } from './types.js';

/** 같은 API 를 상대·절대 경로로 부른 것을 한데 모은다. 같은 출처면 경로만, 다른 출처면 호스트를 붙인다. */
export const pathOf = (url: string): string => {
  const u = parseUrl(url);
  if (!u) return url.split('?')[0];
  return u.origin === location.origin ? u.pathname : `${u.host}${u.pathname}`;
};

// 화면에 보일 Server Action id 길이(전체는 40자 남짓)
const ACTION_ID_LENGTH = 8;

/** Server Action 이면 어느 함수인지 붙인다. 같은 페이지 경로의 서로 다른 함수를 나눠 센다. */
const actionSuffix = (action: string | undefined): string => (action ? ` (action ${action.slice(0, ACTION_ID_LENGTH)})` : '');

/** 쿼리스트링을 뺀 "메서드 경로". 엔드포인트별 집계 단위다. */
export const endpointOf = (record: Pick<RequestRecord, 'method' | 'url' | 'action'>): string =>
  `${record.method} ${pathOf(record.url)}${actionSuffix(record.action)}`;

/**
 * 쿼리스트링과 payload 까지 포함한 요청 단위. 중복·같은 응답 판정은 같은 요청끼리만 한다.
 * 파라미터 순서만 다른 URL 은 같은 요청으로 본다.
 */
export const requestKeyOf = (record: Pick<RequestRecord, 'method' | 'url' | 'requestBody' | 'action'>): string => {
  const u = parseUrl(record.url);
  u?.searchParams.sort();
  return `${record.method} ${u?.href ?? record.url}${actionSuffix(record.action)} ${record.requestBody ?? ''}`;
};
