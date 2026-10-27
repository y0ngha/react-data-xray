import { findRootFibers, getComponentName, hostNodesOf, toCurrent, unionRect, walkFibers } from '../fiber/tree.js';
import { isComposite, type Fiber } from '../fiber/types.js';
import { getOrigin } from '../requests/origins.js';
import { findDerivedOrigin, isIndexPending } from './derivedMatch.js';
import { isSameOrChildPath } from './exactMatch.js';
import { getRecords } from '../requests/store.js';
import type { Origin, RequestRecord } from '../requests/types.js';
import type { Box, Hit } from './types.js';

const MAX_BOXES = 500;

const isPlainChild = (key: string, value: unknown): value is object =>
  key !== 'children' && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value as { $$typeof?: unknown }).$$typeof;

// props 객체가 그대로면(렌더되지 않았으면) 지난번 결과를 쓴다. 파생 매칭이 비싸서 매번 다시 찾지 않는다.
// 기억한 결과가 요청 목록에서 밀려난 응답을 가리키면 다시 찾는다. 수집은 모든 fiber 를 돌므로, 오래 사는
// props(memo 컴포넌트)가 밀려난 응답 본문을 붙잡아 두지 않는다. 통째로 비우면 그때마다 수집이 수십 ms 가 된다.
const hitsByProps = new WeakMap<object, Hit[]>();
// 파생 조회를 미룬 컴포넌트는 직전 결과를 그린다. fiber 는 렌더마다 current 와 alternate 가 번갈아 쓰여 둘 다 키로 둔다.
const lastHits = new WeakMap<Fiber, Hit[]>();

interface Budget {
  until: number;
  deferred: boolean;
  /** 지금 요청 목록에 있는 응답 */
  live: ReadonlySet<RequestRecord>;
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
  // 정확 매칭은 앱이 그 응답 객체를 직접 쥐고 있는 것이라 다시 찾아도 같다. 파생 매칭만 다시 확인한다.
  if (cached?.every((h) => h.match === 'exact' || budget.live.has(h.record))) return remember(fiber, cached);
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
  // 색인 중에는 기억하지 않는다. 색인이 끝난 뒤 수집에서 더 최신 응답이나 못 찾은 출처를 찾는다.
  // (style·theme 처럼 원래 출처가 없는 객체도 "못 찾음"이라, 이것으로 곧바로 다시 수집하게 하면 색인 내내 수집이 이어진다.)
  if (!isIndexPending() || rest.length === 0) hitsByProps.set(props, hits);
  return remember(fiber, hits);
};

/** 경로가 속한 목록 항목. $.data.projects[0].status → $.data.projects[0]. 목록 안이 아니면 경로 그대로 */
const itemOf = (path: string): string => {
  const end = path.lastIndexOf(']');
  return end < 0 ? path : path.slice(0, end + 1);
};

/**
 * 조상 박스가 보여 준 데이터 안이면 다시 그리지 않는다. 조상이 목록 항목 안을 받았으면 그 항목 전체가 범위다
 * (카드가 같은 프로젝트 항목의 status·region·type 을 컴포넌트마다 따로 받는 경우).
 * 다만 그 사이에 목록 첨자([n])가 있으면 덮지 않는다. $.data 를 받은 조상 아래의 목록 행처럼 항목 단위 박스가 더 쓸모 있다.
 */
const covers = (s: Hit, h: Hit): boolean => {
  if (s.record !== h.record) return false;
  const scope = itemOf(s.path);
  return isSameOrChildPath(h.path, scope) && !h.path.slice(scope.length).includes('[');
};
const covered = (shown: readonly Hit[], h: Hit): boolean => shown.some((s) => covers(s, h));

/** 모든 출처가 조상에게 덮였을 때: 가장 가까운 조상(shown 의 뒤쪽)이 보여 준 출처. 그 컴포넌트에 가장 가까운 데이터다. */
const nearestCovered = (shown: readonly Hit[], hits: readonly Hit[]): Hit | undefined => {
  for (let i = shown.length - 1; i >= 0; i--) {
    const hit = hits.find((h) => covers(shown[i], h));
    if (hit) return hit;
  }
  return hits[0];
};

/**
 * 화면의 모든 컴포넌트 중 응답 객체를 props 로 직접 받는 것마다 박스를 만든다.
 * 폴링 화면에서는 카드 수십 개가 한꺼번에 새 데이터를 받아 파생 조회가 몰린다. budgetMs 를 넘기면 남은 컴포넌트는
 * 직전 결과로 그리고 deferred 를 알린다. 부르는 쪽이 곧 다시 부르면 이어서 한다.
 */
export const collectBoxes = (
  isOwnUi: (el: Element) => boolean,
  budgetMs = Infinity,
  /** 이 컴포넌트와 그 아래만 본다(요소 선택으로 고른 분석 대상). 없으면 화면 전체 */
  scope?: Fiber,
): { boxes: Box[]; deferred: boolean } => {
  const boxes: Box[] = [];
  const budget: Budget = { until: performance.now() + budgetMs, deferred: false, live: new Set(getRecords()) };
  /** 컴포넌트 하나를 보고 박스를 만든 뒤 자식으로 내려간다. 고른 대상(root)은 조상과 겹쳐도 자기 출처를 그린다. */
  const visitOne = (f: Fiber, shown: readonly Hit[], isRoot = false): void => {
    if (boxes.length >= MAX_BOXES) return;
    const hits = isComposite(f) ? propHits(f, budget) : [];
    const own = hits.find((h) => !covered(shown, h)) ?? (isRoot ? nearestCovered(shown, hits) : undefined);
    const nodes = own ? hostNodesOf(f).filter((n) => !isOwnUi(n)) : [];
    const rect = unionRect(nodes);
    if (own && rect) boxes.push({ id: boxes.length, rect, nodes, name: getComponentName(f), hit: own, fiber: f });
    visit(f.child, own ? [...shown, own] : shown);
  };
  const visit = (fiber: Fiber | null, shown: readonly Hit[]): void =>
    walkFibers(fiber, (f) => {
      visitOne(f, shown);
      return false;
    });
  if (scope) {
    // 범위 밖 조상이 이미 보여 준 데이터(카드의 프로젝트 항목 등)는 덮인 것으로 보고 시작한다. 화면 전체로 볼 때와 같은 박스가 나온다.
    const root = toCurrent(scope);
    const outer: Fiber[] = [];
    for (let f: Fiber | null = root.return; f; f = f.return) if (isComposite(f)) outer.unshift(f);
    const shown: Hit[] = [];
    outer.forEach((f) => {
      const own = propHits(f, budget).find((h) => !covered(shown, h));
      if (own) shown.push(own);
    });
    visitOne(root, shown, true);
  } else findRootFibers().forEach((root) => visit(root.child, []));
  return { boxes, deferred: budget.deferred };
};
