import { readStored } from './storage.js';

/** 사용자가 요청 탭에서 "의도된 반복"으로 지정한 엔드포인트. 패널과 보고서가 같은 목록을 쓴다. */
export const IGNORE_KEY = 'react-data-xray:ignored-endpoints';

export const parseIgnored = (raw: unknown): ReadonlySet<string> | undefined =>
  Array.isArray(raw) ? new Set(raw.filter((v) => typeof v === 'string')) : undefined;

export const readIgnoredEndpoints = (): ReadonlySet<string> => readStored(IGNORE_KEY, parseIgnored, new Set<string>());
