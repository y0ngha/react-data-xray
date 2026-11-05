import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { isDistinctive } from './derivedMatch.js';
import { MAX_TEXT_LENGTH, numberInText } from './textMatch.js';

/**
 * 과다 응답의 하한값: 응답의 leaf 필드 중 값이 소비자 컴포넌트의 화면 글자에 나타난 것.
 * 화면에 보이지 않게 쓰는 필드(id, 정렬 키, 조건)는 세지 못하므로 실제로 쓰는 필드는 이보다 많을 수 있다.
 */
export interface VisibleFields {
  /** 값이 화면 글자에 나타난 leaf 필드 수 */
  visible: number;
  /** leaf(원시값) 필드 수 */
  total: number;
  /** 비교하지 않은 필드 수(total 에 들어 있다). common: 0·true·한 글자처럼 우연히 겹치는 값, long: 아주 긴 글자, empty: null·빈 글자 */
  notCompared: { common: number; long: number; empty: number };
  /** 보인 필드의 경로(배열 순번은 [] 로 묶는다). 앞쪽 MAX_PATHS 개만 */
  paths: string[];
  /** 응답이 아주 커서 MAX_NODES_PER_BODY 까지만 셌다 */
  truncated: boolean;
}

// 한 번 불릴 때 하는 일의 양. 큐는 4ms 조각 안에서 step 을 거듭 부르므로, 이만큼씩 끊으면 큰 응답도 조각으로 나뉜다.
export const NODES_PER_CALL = 500;
const MAX_PATHS = 20;
// 이보다 긴 글자는 화면에 통째로 그렸을 때만 같은 값으로 본다(설명문 같은 필드). 이보다 길면 비교하지 않는다.
const MAX_LONG_TEXT = 2000;
// 화면 글자를 모으는 도중 소비자 DOM 이 바뀌면 처음부터 다시 모은다. 계속 바뀌면 이만큼만 다시 하고 한 번에 모은다.
const MAX_TEXT_RESTARTS = 3;

// 글자를 그리지 않는 요소. 그 안의 글자는 화면에 보이지 않는다.
const INVISIBLE_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

type Visible = Element & { checkVisibility?: (o?: { visibilityProperty?: boolean }) => boolean };

/** 요소가 화면에 그려지는가. checkVisibility 가 없는 환경(jsdom 등)은 hidden 속성과 인라인 display 만 본다. aria-hidden 은 보이므로 센다. */
const isRendered = (el: Visible): boolean => {
  if (INVISIBLE_TAGS.has(el.tagName) || el.hasAttribute('hidden')) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  return (el as Partial<HTMLElement>).style?.display !== 'none';
};

/** 화면 글자 하나를 비교용 열쇠로. 필드 좁히기(narrowToField)와 같은 규칙: 글자 그대로, 또는 천 단위 쉼표를 걷어 낸 숫자. */
const addTextKeys = (keys: Set<string>, raw: string): void => {
  const text = raw.trim();
  if (!text || text.length > MAX_LONG_TEXT) return;
  keys.add(`s:${text}`);
  if (text.length > MAX_TEXT_LENGTH) return;
  const n = numberInText(text);
  if (n !== undefined) keys.add(`n:${n}`);
};

const leafKey = (value: string | number): string => (typeof value === 'number' ? `n:${value}` : `s:${value}`);

/** 중첩된 소비자(목록과 그 행)는 바깥 것 하나만 읽는다. */
const outermost = (roots: readonly Element[]): Element[] => {
  const set = new Set(roots);
  return Array.from(set).filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
};

const pattern = (path: string): string => path.replace(/\[\d+\]/g, '[]');

/**
 * 소비자 DOM 의 보이는 글자를 모은다. 조각 사이에 앱이 다시 그려 지나던 노드가 문서에서 빠지면, 남은 글자만 세어
 * 수가 조용히 줄지 않게 처음부터 다시 모은다.
 */
function* collectTextKeys(roots: readonly Element[], isOwnUi: (el: Element) => boolean): Generator<void, Set<string>, void> {
  for (let attempt = 0; ; attempt++) {
    const chunked = attempt < MAX_TEXT_RESTARTS;
    const keys = new Set<string>();
    let restart = false;
    let calls = 0;
    for (const root of outermost(roots)) {
      if (!root.isConnected) continue;
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          const el = node as Element;
          // 거부하면 그 아래를 통째로 건너뛴다. 보이는 요소는 건너뛰기만 해서 안의 글자로 내려간다.
          return isRendered(el) && !isOwnUi(el) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        addTextKeys(keys, node.nodeValue ?? '');
        if (!chunked || ++calls % NODES_PER_CALL !== 0) continue;
        yield;
        if (!walker.currentNode.isConnected || !root.isConnected) {
          restart = true;
          break;
        }
      }
      if (restart) break;
    }
    if (!restart) return keys;
  }
}

/** 응답을 훑는 틀 하나. 자식을 한꺼번에 스택에 올리지 않고 index 로 하나씩 꺼내, 10만 개 배열도 조각마다 NODES_PER_CALL 만 본다. */
interface Frame {
  value: object;
  path: string;
  /** 객체의 키(배열이면 없다) */
  keys?: string[];
  index: number;
}

function* measure(body: unknown, roots: readonly Element[], isOwnUi: (el: Element) => boolean): Generator<void, VisibleFields, void> {
  const keys = yield* collectTextKeys(roots, isOwnUi);
  const result: VisibleFields = { visible: 0, total: 0, notCompared: { common: 0, long: 0, empty: 0 }, paths: [], truncated: false };
  const seenPaths = new Set<string>();
  let nodes = 0;
  const visit = (value: unknown, path: string): Frame | undefined => {
    nodes++;
    if (value !== null && typeof value === 'object')
      return { value, path, keys: Array.isArray(value) ? undefined : Object.keys(value), index: 0 };
    if (value === undefined) return undefined;
    result.total++;
    if (value === null || value === '') {
      result.notCompared.empty++;
      return undefined;
    }
    const isLong = typeof value === 'string' && value.length > MAX_TEXT_LENGTH;
    if (isLong && value.length > MAX_LONG_TEXT) {
      result.notCompared.long++;
      return undefined;
    }
    if (!isLong && !isDistinctive(value)) {
      result.notCompared.common++;
      return undefined;
    }
    if (!keys.has(leafKey(value as string | number))) return undefined;
    result.visible++;
    const p = pattern(path);
    if (seenPaths.size < MAX_PATHS && !seenPaths.has(p)) {
      seenPaths.add(p);
      result.paths.push(p);
    }
    return undefined;
  };
  const stack: Frame[] = [];
  const first = visit(body, '$');
  if (first) stack.push(first);
  let budget = NODES_PER_CALL;
  while (stack.length > 0) {
    if (nodes >= MAX_NODES_PER_BODY) {
      result.truncated = true;
      break;
    }
    if (--budget <= 0) {
      yield;
      budget = NODES_PER_CALL;
    }
    const frame = stack[stack.length - 1];
    const length = frame.keys ? frame.keys.length : (frame.value as unknown[]).length;
    if (frame.index >= length) {
      stack.pop();
      continue;
    }
    const i = frame.index++;
    const [value, path] = frame.keys
      ? [(frame.value as Record<string, unknown>)[frame.keys[i]], `${frame.path}.${frame.keys[i]}`]
      : [(frame.value as unknown[])[i], `${frame.path}[${i}]`];
    const child = visit(value, path);
    if (child) stack.push(child);
  }
  return result;
}

/** 조각 단위 생성기. 테스트에서 조각마다 하는 일의 양을 볼 때 쓴다. */
export const visibleFieldSteps = measure;

/** 다 셀 때까지 돌린다(테스트·동기 호출용). */
export const countVisibleFields = (
  body: unknown,
  roots: readonly Element[],
  isOwnUi: (el: Element) => boolean = () => false,
): VisibleFields => {
  const job = measure(body, roots, isOwnUi);
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
};

/**
 * 유휴 큐에서 조각으로 센다. 큰 응답(수만 필드)도 메인 스레드를 한 번에 막지 않는다. 그만 셀 때는 돌려준 함수를 부른다.
 * 응답 객체를 Proxy 로 감싸 읽는 필드를 세지 않는 이유는 docs/CONTEXT.md 4.6 에 있다.
 */
export const measureVisibleFields = (
  body: unknown,
  roots: readonly Element[],
  isOwnUi: (el: Element) => boolean,
  onDone: (result: VisibleFields) => void,
): (() => void) => {
  let cancelled = false;
  const job = measure(body, roots, isOwnUi);
  enqueue(() => {
    if (cancelled) return true;
    const next = job.next();
    if (!next.done) return false;
    onDone(next.value);
    return true;
  });
  return () => {
    cancelled = true;
  };
};
