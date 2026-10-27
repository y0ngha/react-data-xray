import { getRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import type { Hit } from './types.js';

const MAX_NODES_PER_BODY = 50_000;
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
  for (const record of getRecords().toReversed()) {
    if (hits.length >= limit) break;
    hits.push(...findInBody(record, needle, limit - hits.length));
  }
  return hits;
};
