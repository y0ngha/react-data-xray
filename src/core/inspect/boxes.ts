import { findRootFibers, getComponentName, hostNodesOf, unionRect, walkFibers } from '../fiber/tree.js';
import { isComposite, type Fiber } from '../fiber/types.js';
import { getOrigin } from '../requests/origins.js';
import { findDerivedOrigin, isIndexPending } from './derivedMatch.js';
import { isSameOrChildPath } from './exactMatch.js';
import type { Origin } from '../requests/types.js';
import type { Box, Hit } from './types.js';

const MAX_BOXES = 500;

const isPlainChild = (key: string, value: unknown): value is object =>
  key !== 'children' && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value as { $$typeof?: unknown }).$$typeof;

// props 객체가 그대로면(렌더되지 않았으면) 지난번 결과를 쓴다. 파생 매칭이 비싸서 매번 다시 찾지 않는다.
const hitsByProps = new WeakMap<object, Hit[]>();
// 파생 조회를 미룬 컴포넌트는 직전 결과를 그린다. fiber 는 렌더마다 current 와 alternate 가 번갈아 쓰여 둘 다 키로 둔다.
const lastHits = new WeakMap<Fiber, Hit[]>();

interface Budget {
  until: number;
  deferred: boolean;
}

const remember = (fiber: Fiber, hits: Hit[]): Hit[] => {
  lastHits.set(fiber, hits);
  if (fiber.alternate) lastHits.set(fiber.alternate, hits);
  return hits;
};

const plainEntries = (props: object): Array<[string, object]> =>
  Object.entries(props).filter((entry): entry is [string, object] => isPlainChild(entry[0], entry[1]));

const toHit = (k: string, origin: Origin, match: Hit['match']): Hit => ({
  record: origin.record,
  path: origin.path,
  via: `props.${k}`,
  match,
});

/**
 * props 로 받은 응답 객체(배열 제외)들. 목록의 행, 카드처럼 화면 단위와 맞는다.
 * 카드가 목록 항목(정확)과 다른 응답의 복사본(파생)을 함께 받는 것처럼 출처가 여럿일 수 있어 모두 찾는다.
 */
const propHits = (fiber: Fiber, budget: Budget): Hit[] => {
  const props = fiber.memoizedProps;
  if (!props || typeof props !== 'object') return [];
  const cached = hitsByProps.get(props);
  if (cached) return remember(fiber, cached);
  const entries = plainEntries(props);
  const exact = entries.flatMap(([k, v]) => {
    const origin = getOrigin(v);
    return origin ? [toHit(k, origin, 'exact')] : [];
  });
  const rest = entries.filter(([, v]) => !getOrigin(v));
  if (rest.length > 0 && performance.now() > budget.until) {
    budget.deferred = true;
    return lastHits.get(fiber) ?? exact;
  }
  const derived = rest.flatMap(([k, v]) => {
    const origin = findDerivedOrigin(v);
    return origin ? [toHit(k, origin, 'derived')] : [];
  });
  const hits = [...exact, ...derived];
  // 색인 중에 못 찾은 것은 기억하지 않는다. 색인이 끝나면 찾을 수 있다.
  if (rest.length === derived.length || !isIndexPending()) hitsByProps.set(props, hits);
  return remember(fiber, hits);
};

/** 경로가 속한 목록 항목. $.data.projects[0].status → $.data.projects[0]. 목록 안이 아니면 경로 그대로 */
const itemOf = (path: string): string => {
  const end = path.lastIndexOf(']');
  return end < 0 ? path : path.slice(0, end + 1);
};

// 조상 박스가 보여 준 항목 안의 데이터면 다시 그리지 않는다. 카드가 같은 프로젝트 항목의 status·region·type 을
// 컴포넌트마다 따로 받거나, 같은 객체를 래퍼가 넘겨받을 때 박스가 겹겹이 생기지 않게 한다.
// 응답 전체($)를 받은 조상은 같은 경로만 덮는다. 그 아래 목록 행처럼 항목 단위 박스가 더 쓸모 있다.
const covered = (shown: readonly Hit[], h: Hit): boolean =>
  shown.some((s) => s.record === h.record && (s.path === h.path || (itemOf(s.path) !== '$' && isSameOrChildPath(h.path, itemOf(s.path)))));

/**
 * 화면의 모든 컴포넌트 중 응답 객체를 props 로 직접 받는 것마다 박스를 만든다.
 * 폴링 화면에서는 카드 수십 개가 한꺼번에 새 데이터를 받아 파생 조회가 몰린다. budgetMs 를 넘기면 남은 컴포넌트는
 * 직전 결과로 그리고 deferred 를 알린다. 부르는 쪽이 곧 다시 부르면 이어서 한다.
 */
export const collectBoxes = (isOwnUi: (el: Element) => boolean, budgetMs = Infinity): { boxes: Box[]; deferred: boolean } => {
  const boxes: Box[] = [];
  const budget: Budget = { until: performance.now() + budgetMs, deferred: false };
  const visit = (fiber: Fiber | null, shown: readonly Hit[]): void =>
    walkFibers(fiber, (f) => {
      if (boxes.length >= MAX_BOXES) return false;
      const hits = isComposite(f) ? propHits(f, budget) : [];
      const own = hits.find((h) => !covered(shown, h));
      const nodes = own ? hostNodesOf(f).filter((n) => !isOwnUi(n)) : [];
      const rect = unionRect(nodes);
      if (own && rect) boxes.push({ id: boxes.length, rect, nodes, name: getComponentName(f), hit: own, fiber: f });
      visit(f.child, own ? [...shown, own] : shown);
      return false;
    });
  findRootFibers().forEach((root) => visit(root.child, []));
  return { boxes, deferred: budget.deferred };
};
