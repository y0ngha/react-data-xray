import { groupBy } from '../../shared/collections.js';
import type { Hit } from './types.js';

/** 배열 원소 단위의 경로. `$.list[3].region` → `$.list[3]` */
const itemPathOf = (path: string): string => path.match(/^(.*\[\d+\])/)?.[1] ?? path;

/** 같은 응답 항목(배열의 한 원소)의 하위 객체들을 여러 props 로 받은 경우 한 줄로 묶는다. */
const mergeGroup = ([first, ...rest]: Hit[]): Hit =>
  rest.length === 0
    ? first
    : Object.assign({}, first, { path: itemPathOf(first.path), via: [first, ...rest].map((h) => h.via).join(', ') });

export const mergeHits = (hits: readonly Hit[]): Hit[] =>
  Array.from(groupBy(hits, (hit) => `${hit.record.id}|${itemPathOf(hit.path)}|${hit.match}`).values(), mergeGroup);
