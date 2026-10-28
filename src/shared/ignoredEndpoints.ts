import { maskEndpoint } from '../core/requests/requestKey.js';
import { readStored } from './storage.js';

/** 사용자가 요청 탭에서 "의도된 반복"으로 지정한 엔드포인트. 패널과 보고서가 같은 목록을 쓴다. */
export const IGNORE_KEY = 'react-data-xray:ignored-endpoints';

// 저장된 키도 지금의 ID 묶기 규칙으로 바꾼다. 묶기 전에 저장한 경로는 어느 엔드포인트와도 안 맞고 화면에서 지울 수도 없다.
export const parseIgnored = (raw: unknown): ReadonlySet<string> | undefined =>
  Array.isArray(raw) ? new Set(raw.filter((v): v is string => typeof v === 'string').map(maskEndpoint)) : undefined;

export const readIgnoredEndpoints = (): ReadonlySet<string> => readStored(IGNORE_KEY, parseIgnored, new Set<string>());
