import { getOrigin, getRecords, type RequestRecord } from './registry';

// React 내부 구조(fiber)는 공개 API가 아니다. 18, 19에서 같은 필드를 쓴다.
interface Fiber {
  tag: number;
  type: unknown;
  return: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  stateNode: unknown;
}

interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}

export interface Hit {
  record: RequestRecord;
  /** 응답 본문 안의 위치. 예: $.data.list[3].title */
  path: string;
  /** 컴포넌트 안에서 값이 있던 곳. 예: props.row, hook[2] */
  via: string;
  queryKey?: unknown;
  exact: boolean;
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
const FORWARD_REF = 11;
// memo(Comp, compare)(tag 14)는 안쪽 Comp 가 따로 fiber 를 가지므로 넣지 않는다.
const SIMPLE_MEMO = 15;
const COMPOSITE_TAGS = new Set([FUNCTION, CLASS, FORWARD_REF, SIMPLE_MEMO]);

const MAX_COMPONENTS = 8;
const MAX_SEARCH_DEPTH = 4;
const MAX_HITS_PER_COMPONENT = 10;

export const getFiber = (el: Element): Fiber | null => {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (key) return (node as unknown as Record<string, Fiber>)[key];
  }
  return null;
};

export const getComponentName = (fiber: Fiber): string => {
  const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return type?.displayName || type?.name || type?.render?.name || type?.type?.name || 'Anonymous';
};

/** react-query 의 QueryObserver 인지 모양으로 판단한다(패키지에 의존하지 않기 위해). */
interface QueryObserverLike {
  getCurrentResult: () => { data?: unknown };
  options: { queryKey: unknown };
}

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
      values.push({ via: `useQuery`, value: observer.getCurrentResult().data, queryKey: observer.options.queryKey });
    } else {
      values.push({ via: `hook[${i}]`, value: hook.memoizedState });
    }
  }
  return values;
};

const findOrigins = (root: unknown, via: string, queryKey: unknown, hits: Hit[]) => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, where: string, depth: number) => {
    if (hits.length >= MAX_HITS_PER_COMPONENT || value === null || typeof value !== 'object') return;
    if (seen.has(value) || (typeof Node !== 'undefined' && value instanceof Node)) return;
    seen.add(value);
    const origin = getOrigin(value);
    if (origin) {
      // 같은 응답의 하위 객체를 또 내려가며 찾을 필요는 없다.
      if (!hits.some((h) => h.record === origin.record && origin.path.startsWith(h.path))) {
        hits.push({ record: origin.record, path: origin.path, via: where, queryKey, exact: true });
      }
      return;
    }
    if (depth >= MAX_SEARCH_DEPTH) return;
    // React element 의 _owner 등 내부 필드로 끝없이 퍼지는 것을 막는다.
    if ((value as { $$typeof?: unknown }).$$typeof) {
      walk((value as { props?: unknown }).props, `${where}.props`, depth + 1);
      return;
    }
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [k, v] of entries.slice(0, 200)) walk(v, Array.isArray(value) ? `${where}[${k}]` : `${where}.${k}`, depth + 1);
  };
  walk(root, via, 0);
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
        hits.push({ record, path, via: 'text', exact: false });
      }
    };
    walk(record.body, '$');
  }
  return hits;
};

export const inspect = (el: Element): InspectResult => {
  const components: ComponentResult[] = [];
  for (let fiber = getFiber(el); fiber && components.length < MAX_COMPONENTS; fiber = fiber.return) {
    if (!COMPOSITE_TAGS.has(fiber.tag)) continue;
    const hits: Hit[] = [];
    for (const { via, value, queryKey } of collectValues(fiber)) findOrigins(value, via, queryKey, hits);
    components.push({ name: getComponentName(fiber), hits });
  }
  const found = components.some((c) => c.hits.length > 0);
  const text = el.childElementCount === 0 ? el.textContent ?? '' : '';
  return { components, guesses: found ? [] : guessByText(text) };
};
