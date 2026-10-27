import { getOrigin } from '../requests/origins.js';
import { childEntries } from './objectWalk.js';
import type { Hit } from './types.js';

const MAX_SEARCH_DEPTH = 4;
const MAX_HITS = 10;
const MAX_CANDIDATES = 30;
const MAX_CHILDREN = 200;

/** 참조로 출처를 못 찾은 객체. 파생 매칭 후보가 된다. */
export interface Candidate {
  value: object;
  where: string;
}

/** `$.a[1]` 아래의 `$.a[1].b` 는 포함하지만 `$.a[10]` 이나 `$.ab` 는 포함하지 않는다. */
export const isSameOrChildPath = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);

/**
 * 값 안에서 응답 객체를 같은 참조로 찾는다. 응답 객체를 찾으면 그 아래는 더 내려가지 않는다.
 * 참조로 못 찾은 객체는 파생 매칭 후보로 함께 돌려준다.
 */
export const findExactOrigins = (root: unknown, via: string, queryKey?: unknown): { hits: Hit[]; candidates: Candidate[] } => {
  const hits: Hit[] = [];
  const candidates: Candidate[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, where: string, depth: number): void => {
    if (hits.length >= MAX_HITS || value === null || typeof value !== 'object' || seen.has(value)) return;
    if (typeof Node !== 'undefined' && value instanceof Node) return;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) {
      // 같은 응답의 하위 객체를 또 찾을 필요는 없다.
      if (!hits.some((h) => h.record === origin.record && isSameOrChildPath(origin.path, h.path))) {
        hits.push({ record: origin.record, path: origin.path, via: where, queryKey, match: 'exact' });
      }
      return;
    }
    // React element 는 props 만 따라간다(_owner 등으로 끝없이 퍼지는 것을 막는다).
    if ((value as { $$typeof?: unknown }).$$typeof) {
      if (depth < MAX_SEARCH_DEPTH) walk((value as { props?: unknown }).props, `${where}.props`, depth + 1);
      return;
    }
    if (!Array.isArray(value) && candidates.length < MAX_CANDIDATES) candidates.push({ value, where });
    if (depth < MAX_SEARCH_DEPTH) childEntries(value, MAX_CHILDREN).forEach(([key, child]) => walk(child, `${where}${key}`, depth + 1));
  };
  walk(root, via, 0);
  return { hits, candidates };
};
