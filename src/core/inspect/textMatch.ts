import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import { getRecords } from '../requests/store.js';
import { valueAt } from '../../shared/format.js';
import type { RequestRecord } from '../requests/types.js';
import type { Hit } from './types.js';

const MAX_TEXT_LENGTH = 200;

const findInBody = (record: RequestRecord, needle: string, limit: number): Hit[] => {
  const hits: Hit[] = [];
  let nodes = 0;
  const walk = (value: unknown, path: string): void => {
    if (hits.length >= limit || nodes++ > MAX_NODES_PER_BODY || value === null || value === undefined) return;
    if (typeof value !== 'object') {
      if (String(value) === needle) hits.push({ record, path, via: 'text', match: 'text' });
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else Object.entries(value).forEach(([k, v]) => walk(v, `${path}.${k}`));
  };
  walk(record.body, '$');
  return hits;
};

/** 화면 글자와 같은 값을 최근 응답부터 찾는다. 참조로 못 찾았을 때만 쓰는 추정치다. */
export const guessByText = (text: string, limit = 5): Hit[] => {
  const needle = text.trim();
  if (!needle || needle.length > MAX_TEXT_LENGTH) return [];
  const hits: Hit[] = [];
  for (const record of [...getRecords()].reverse()) {
    if (hits.length >= limit) break;
    hits.push(...findInBody(record, needle, limit - hits.length));
  }
  return hits;
};

/** 화면 글자와 같은 값인지. 숫자는 화면 표기의 천 단위 쉼표를 걷어 낸다(1,234 = 1234). */
const sameValue = (value: unknown, needle: string): boolean =>
  value !== null &&
  value !== undefined &&
  typeof value !== 'object' &&
  (String(value) === needle || (typeof value === 'number' && needle !== '' && Number(needle.replace(/,/g, '')) === value));

/** base 아래에서 needle 과 같은 값을 가진 경로들(최대 2개까지만 찾는다: 하나인지만 알면 된다) */
const fieldPathsOf = (base: unknown, basePath: string, needle: string): string[] => {
  const found: string[] = [];
  let nodes = 0;
  const walk = (value: unknown, path: string): void => {
    if (found.length > 1 || nodes++ > MAX_NODES_PER_BODY) return;
    if (sameValue(value, needle)) found.push(path);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, `${path}.${k}`));
  };
  walk(base, basePath);
  return found;
};

/**
 * 출처 경로를 클릭한 글자가 있는 필드까지 좁힌다($ → $.data.summary.total).
 * 같은 값이 그 안에 하나뿐일 때만 좁힌다. 0 처럼 여러 필드에 있는 값은 어느 필드인지 모르니 그대로 둔다.
 */
export const narrowToField = (hit: Hit, text: string): Hit => {
  const needle = text.trim();
  if (!needle || needle.length > MAX_TEXT_LENGTH || hit.record.body === undefined) return hit;
  const base = valueAt(hit.record.body, hit.path);
  if (base === null || typeof base !== 'object') return hit;
  const paths = fieldPathsOf(base, hit.path, needle);
  return paths.length === 1 ? { ...hit, path: paths[0] } : hit;
};
