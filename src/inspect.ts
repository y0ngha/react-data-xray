import { getBodyVersion, getOrigin, getRecords, requestKeyOf, type Origin, type RequestRecord } from './registry.js';

// React 내부 구조(fiber)는 공개 API가 아니다. 18, 19에서 같은 필드를 쓴다.
interface Fiber {
  tag: number;
  alternate: Fiber | null;
  type: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  stateNode: unknown;
}

interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}

/** exact: 같은 참조 · derived: 가공된 객체지만 필드 값이 응답 객체와 일치 · text: 화면 글자만 일치 */
export type MatchKind = 'exact' | 'derived' | 'text';

export interface Hit {
  record: RequestRecord;
  /** 응답 본문 안의 위치. 예: $.data.list[3].title */
  path: string;
  /** 컴포넌트 안에서 값이 있던 곳. 예: props.row, hook[2] */
  via: string;
  queryKey?: unknown;
  match: MatchKind;
}

export interface ComponentResult {
  name: string;
  hits: Hit[];
}

export interface InspectResult {
  components: ComponentResult[];
  guesses: Hit[];
}

const FUNCTION = 0;
const CLASS = 1;
const HOST_ROOT = 3;
const HOST_COMPONENT = 5;
const FORWARD_REF = 11;
// memo(Comp, compare)(tag 14)는 안쪽 Comp 가 따로 fiber 를 가지므로 넣지 않는다.
const SIMPLE_MEMO = 15;
const COMPOSITE_TAGS = new Set([FUNCTION, CLASS, FORWARD_REF, SIMPLE_MEMO]);

// styled 래퍼, Tooltip 같은 중간 컴포넌트가 많아 데이터를 가진 컴포넌트까지 꽤 올라가야 한다.
const MAX_COMPONENTS = 60;
const MAX_COMPONENTS_WITH_HITS = 3;
const MAX_SEARCH_DEPTH = 4;
const MAX_HITS_PER_COMPONENT = 10;
const MAX_DERIVED_CANDIDATES = 30;
// 이만큼의 필드 값이 같아야 같은 데이터를 가공한 객체로 본다.
const MIN_DERIVED_FIELDS = 2;

/**
 * DOM 에 붙은 fiber 는 current 일 수도, 지난 commit 의 alternate 일 수도 있다.
 * HostRoot 까지 올라가 root.current 와 같은 쪽 트리인지 보고, 아니면 alternate 를 쓴다.
 */
const toCurrent = (fiber: Fiber): Fiber => {
  let node = fiber;
  while (node.return) node = node.return;
  if (node.tag !== HOST_ROOT) return fiber;
  const root = node.stateNode as { current?: Fiber } | null;
  return root?.current === node ? fiber : (fiber.alternate ?? fiber);
};

export const getFiber = (el: Element): Fiber | null => {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (key) return toCurrent((node as unknown as Record<string, Fiber>)[key]);
  }
  return null;
};

export const getComponentName = (fiber: Fiber): string => {
  const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return type?.displayName || type?.name || type?.render?.name || type?.type?.name || 'Anonymous';
};

interface QueryObserverLike {
  getCurrentResult: () => { data?: unknown };
  options: { queryKey: unknown };
}

/** react-query 의 QueryObserver 인지 모양으로 판단한다(패키지에 의존하지 않기 위해). */
const asQueryObserver = (value: unknown): QueryObserverLike | null => {
  const v = value as Partial<QueryObserverLike> | null;
  return v && typeof v.getCurrentResult === 'function' && v.options?.queryKey ? (v as QueryObserverLike) : null;
};

/** 컴포넌트가 들고 있는 값들: props, 훅 state(함수형), state(클래스형). */
const collectValues = (fiber: Fiber): Array<{ via: string; value: unknown; queryKey?: unknown }> => {
  const values: Array<{ via: string; value: unknown; queryKey?: unknown }> = [{ via: 'props', value: fiber.memoizedProps }];
  if (fiber.tag === CLASS) {
    values.push({ via: 'state', value: fiber.memoizedState });
    return values;
  }
  let hook = fiber.memoizedState as Hook | null;
  for (let i = 0; hook && typeof hook === 'object' && 'next' in hook; i++, hook = hook.next) {
    const observer = asQueryObserver(hook.memoizedState);
    if (observer) {
      values.push({ via: 'useQuery', value: observer.getCurrentResult().data, queryKey: observer.options.queryKey });
    } else {
      values.push({ via: `hook[${i}]`, value: hook.memoizedState });
    }
  }
  return values;
};

// ---- 파생 매칭: "필드명=값" 색인으로 가공된 객체의 원본 응답 객체를 찾는다 ----

let fieldIndex: Map<string, Origin[]> | null = null;
let fieldIndexVersion = -1;
let fieldIndexBuiltAt = 0;
// 폴링 화면에서는 응답이 계속 들어오므로, 색인을 다시 만드는 것은 2초에 한 번으로 줄인다.
const FIELD_INDEX_MIN_AGE_MS = 2000;

const isDistinctive = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.length >= 2 && v.length <= 200) || (typeof v === 'number' && Math.abs(v) >= 10);

const getFieldIndex = (): Map<string, Origin[]> => {
  const version = getBodyVersion();
  if (fieldIndex && (version === fieldIndexVersion || Date.now() - fieldIndexBuiltAt < FIELD_INDEX_MIN_AGE_MS)) return fieldIndex;
  fieldIndexVersion = version;
  fieldIndexBuiltAt = Date.now();
  const index = new Map<string, Origin[]>();
  for (const record of getRecords()) {
    let nodes = 0;
    const walk = (value: unknown, path: string) => {
      if (value === null || typeof value !== 'object' || nodes++ > 50_000) return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      const origin: Origin = { record, path };
      for (const [k, v] of Object.entries(value)) {
        if (isDistinctive(v)) {
          const key = `${k}\u0000${v}`;
          const list = index.get(key);
          if (list) list.push(origin);
          else index.set(key, [origin]);
        } else {
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(record.body, '$');
  }
  fieldIndex = index;
  return index;
};

/** 객체의 필드 값과 가장 많이 겹치는 응답 객체를 찾는다. */
export const findDerivedOrigin = (value: object): Origin | null => {
  const index = getFieldIndex();
  const scores = new Map<Origin, number>();
  for (const [k, v] of Object.entries(value)) {
    if (!isDistinctive(v)) continue;
    for (const origin of index.get(`${k}\u0000${v}`) ?? []) scores.set(origin, (scores.get(origin) ?? 0) + 1);
  }
  let best: Origin | null = null;
  let bestScore = 0;
  // 최신 응답을 우선한다(색인은 오래된 순이므로 같은 점수면 뒤의 것을 고른다).
  for (const [origin, score] of scores) {
    if (score >= MIN_DERIVED_FIELDS && score >= bestScore) {
      best = origin;
      bestScore = score;
    }
  }
  return best;
};

// ---- 컴포넌트 하나에서 출처 찾기 ----

/** `$.a[1]` 아래의 `$.a[1].b` 는 포함하지만 `$.a[10]` 이나 `$.ab` 는 포함하지 않는다. */
const isSameOrChildPath = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);

const findOrigins = (root: unknown, via: string, queryKey: unknown, hits: Hit[], candidates: Array<{ value: object; where: string }>) => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, where: string, depth: number) => {
    if (hits.length >= MAX_HITS_PER_COMPONENT || value === null || typeof value !== 'object') return;
    if (seen.has(value) || (typeof Node !== 'undefined' && value instanceof Node)) return;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) {
      // 같은 응답의 하위 객체를 또 내려가며 찾을 필요는 없다.
      if (!hits.some((h) => h.record === origin.record && isSameOrChildPath(origin.path, h.path))) {
        hits.push({ record: origin.record, path: origin.path, via: where, queryKey, match: 'exact' });
      }
      return;
    }
    // React element 의 _owner 등 내부 필드로 끝없이 퍼지는 것을 막는다.
    if ((value as { $$typeof?: unknown }).$$typeof) {
      if (depth < MAX_SEARCH_DEPTH) walk((value as { props?: unknown }).props, `${where}.props`, depth + 1);
      return;
    }
    if (!Array.isArray(value) && candidates.length < MAX_DERIVED_CANDIDATES) candidates.push({ value, where });
    if (depth >= MAX_SEARCH_DEPTH) return;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [k, v] of entries.slice(0, 200)) walk(v, Array.isArray(value) ? `${where}[${k}]` : `${where}.${k}`, depth + 1);
  };
  walk(root, via, 0);
};

/** 같은 응답 항목(배열의 한 원소)의 하위 객체들을 여러 props 로 받은 경우 한 줄로 묶는다. */
const mergeHits = (hits: Hit[]): Hit[] => {
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) {
    const item = hit.path.match(/^(.*\[\d+\])/)?.[1] ?? hit.path;
    const key = `${hit.record.id}|${item}|${hit.match}`;
    groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];
    const item = group[0].path.match(/^(.*\[\d+\])/)?.[1] ?? group[0].path;
    return { ...group[0], path: item, via: group.map((h) => h.via).join(', ') };
  });
};

export const inspectFiber = (fiber: Fiber): Hit[] => {
  const hits: Hit[] = [];
  const candidates: Array<{ value: object; where: string }> = [];
  for (const { via, value, queryKey } of collectValues(fiber)) findOrigins(value, via, queryKey, hits, candidates);
  if (hits.length > 0) return mergeHits(hits);
  for (const { value, where } of candidates) {
    const origin = findDerivedOrigin(value);
    if (origin && !hits.some((h) => h.record === origin.record && h.path === origin.path)) {
      hits.push({ record: origin.record, path: origin.path, via: where, match: 'derived' });
      if (hits.length >= MAX_HITS_PER_COMPONENT) break;
    }
  }
  return mergeHits(hits);
};

/** 화면 글자와 같은 값을 응답에서 찾는다. 참조로 못 찾았을 때만 쓰는 추정치다. */
export const guessByText = (text: string, limit = 5): Hit[] => {
  const needle = text.trim();
  if (!needle || needle.length > 200) return [];
  const hits: Hit[] = [];
  const records = getRecords();
  for (let r = records.length - 1; r >= 0 && hits.length < limit; r--) {
    const record = records[r];
    let nodes = 0;
    const walk = (value: unknown, path: string) => {
      if (hits.length >= limit || nodes++ > 50_000) return;
      if (value !== null && typeof value === 'object') {
        if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
        else for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      } else if (value !== null && value !== undefined && String(value) === needle) {
        hits.push({ record, path, via: 'text', match: 'text' });
      }
    };
    walk(record.body, '$');
  }
  return hits;
};

export const inspect = (el: Element): InspectResult => {
  const components: ComponentResult[] = [];
  let withHits = 0;
  for (let fiber = getFiber(el); fiber && components.length < MAX_COMPONENTS && withHits < MAX_COMPONENTS_WITH_HITS; fiber = fiber.return) {
    if (!COMPOSITE_TAGS.has(fiber.tag)) continue;
    const hits = inspectFiber(fiber);
    components.push({ name: getComponentName(fiber), hits });
    if (hits.length > 0) withHits++;
  }
  const text = el.childElementCount === 0 ? el.textContent ?? '' : '';
  return { components, guesses: withHits > 0 ? [] : guessByText(text) };
};

// ---- 전체 표시: 화면의 모든 컴포넌트 중 응답 객체를 props 로 직접 받는 것을 찾는다 ----

export interface Box {
  rect: DOMRect;
  name: string;
  hit: Hit;
  /** 렌더 횟수를 찾을 때 쓰는 컴포넌트 fiber */
  fiber: unknown;
}

// React 루트 컨테이너는 거의 바뀌지 않으므로 찾은 것을 기억해 두고, 없을 때만 페이지를 훑는다.
let rootContainers: Element[] = [];

const containerKey = (el: Element) => Object.keys(el).find((k) => k.startsWith('__reactContainer$'));

const findRootFibers = (): Fiber[] => {
  rootContainers = rootContainers.filter((el) => el.isConnected && containerKey(el));
  if (rootContainers.length === 0) rootContainers = Array.from(document.querySelectorAll('*')).filter((el) => containerKey(el));
  // 컨테이너에 붙은 HostRoot fiber 는 처음 만든 것이라 commit 마다 current/alternate 가 바뀐다. root.current 로 따라간다.
  return rootContainers.map((el) => {
    const hostRoot = (el as unknown as Record<string, Fiber>)[containerKey(el)!];
    return (hostRoot.stateNode as { current?: Fiber } | null)?.current ?? hostRoot;
  });
};

const hostNodesOf = (fiber: Fiber): Element[] => {
  const nodes: Element[] = [];
  const visit = (f: Fiber | null) => {
    for (; f; f = f.sibling) {
      if (f.tag === HOST_COMPONENT && f.stateNode instanceof Element) nodes.push(f.stateNode);
      else visit(f.child);
    }
  };
  visit(fiber.child);
  return nodes;
};

const unionRect = (els: Element[]): DOMRect | null => {
  const rects = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
};

/** props 에 응답 객체(배열 제외)를 직접 받는 컴포넌트만 고른다. 목록의 행, 카드처럼 화면 단위와 맞는다. */
const directPropHit = (fiber: Fiber): Hit | null => {
  const props = fiber.memoizedProps as Record<string, unknown> | null;
  if (!props || typeof props !== 'object') return null;
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children' || v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    const origin = getOrigin(v);
    if (origin) return { record: origin.record, path: origin.path, via: `props.${k}`, match: 'exact' };
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children' || v === null || typeof v !== 'object' || Array.isArray(v) || (v as { $$typeof?: unknown }).$$typeof) continue;
    const origin = findDerivedOrigin(v);
    if (origin) return { record: origin.record, path: origin.path, via: `props.${k}`, match: 'derived' };
  }
  return null;
};

const MAX_BOXES = 500;

export const collectBoxes = (isOwnUi: (el: Element) => boolean): Box[] => {
  const boxes: Box[] = [];
  const visit = (fiber: Fiber | null, parentHit: Hit | null) => {
    for (let f = fiber; f && boxes.length < MAX_BOXES; f = f.sibling) {
      let hit = parentHit;
      if (COMPOSITE_TAGS.has(f.tag)) {
        const own = directPropHit(f);
        // 부모와 같은 객체를 그대로 넘겨받은 래퍼 컴포넌트는 박스를 또 그리지 않는다.
        if (own && !(parentHit && parentHit.record === own.record && parentHit.path === own.path)) {
          const nodes = hostNodesOf(f).filter((n) => !isOwnUi(n));
          const rect = unionRect(nodes);
          if (rect) boxes.push({ rect, name: getComponentName(f), hit: own, fiber: f });
          hit = own;
        }
      }
      visit(f.child, hit);
    }
  };
  for (const root of findRootFibers()) visit(root.child, null);
  return boxes;
};

// ---- 요청 → 컴포넌트: 이 요청의 응답 데이터를 쓰는 컴포넌트를 찾는다 ----

export interface Consumer {
  name: string;
  rect: DOMRect | null;
  /** 컴포넌트 안에서 데이터가 있던 곳. 예: props.item, useQuery */
  via: string;
}

const MAX_CONSUMERS = 300;
const MAX_CONSUMER_DEPTH = 3;

/**
 * 같은 요청(메서드·URL·payload)의 응답 객체를 props·훅 state 로 들고 있는 컴포넌트.
 * React Query 는 응답이 같으면 이전 객체를 재사용하므로, 이 요청 하나가 아니라 같은 요청의 이전 응답까지 함께 본다.
 */
export const findConsumers = (record: RequestRecord, isOwnUi: (el: Element) => boolean): Consumer[] => {
  const key = requestKeyOf(record);
  const consumers: Consumer[] = [];
  const holds = (root: unknown): boolean => {
    const seen = new WeakSet<object>();
    const walk = (value: unknown, depth: number): boolean => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return false;
      if (typeof Node !== 'undefined' && value instanceof Node) return false;
      seen.add(value);
      const origin = getOrigin(value);
      if (origin) return requestKeyOf(origin.record) === key;
      if (depth >= MAX_CONSUMER_DEPTH || (value as { $$typeof?: unknown }).$$typeof) return false;
      const children = Array.isArray(value) ? value.slice(0, 100) : Object.values(value).slice(0, 100);
      return children.some((child) => walk(child, depth + 1));
    };
    return walk(root, 0);
  };
  const visit = (fiber: Fiber | null) => {
    for (let f = fiber; f && consumers.length < MAX_CONSUMERS; f = f.sibling) {
      if (COMPOSITE_TAGS.has(f.tag)) {
        const found = collectValues(f).find(({ value }) => holds(value));
        if (found) {
          const nodes = hostNodesOf(f).filter((n) => !isOwnUi(n));
          if (nodes.length > 0) consumers.push({ name: getComponentName(f), rect: unionRect(nodes), via: found.via });
        }
      }
      visit(f.child);
    }
  };
  for (const root of findRootFibers()) visit(root.child);
  return consumers;
};
