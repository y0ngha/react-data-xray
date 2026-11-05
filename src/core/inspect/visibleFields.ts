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
  /** 0, true, 짧은 글자처럼 우연히 겹치는 흔한 값이라 비교하지 않은 필드 수(total 에 들어 있다) */
  common: number;
  /** 보인 필드의 경로(배열 순번은 [] 로 묶는다). 앞쪽 MAX_PATHS 개만 */
  paths: string[];
  /** 응답이 아주 커서 MAX_NODES_PER_BODY 까지만 셌다 */
  truncated: boolean;
}

// 한 번 불릴 때 하는 일의 양. 큐는 4ms 조각 안에서 step 을 거듭 부르므로, 이만큼씩 끊으면 큰 응답도 조각으로 나뉜다.
const TEXT_NODES_PER_CALL = 500;
const BODY_NODES_PER_CALL = 500;
const MAX_PATHS = 20;

/** 화면 글자 하나를 비교용 열쇠로. 필드 좁히기(narrowToField)와 같은 규칙: 글자 그대로, 또는 천 단위 쉼표를 걷어 낸 숫자. */
const addTextKeys = (keys: Set<string>, raw: string): void => {
  const text = raw.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) return;
  keys.add(`s:${text}`);
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

/** 화면 글자를 모은 뒤 응답을 훑는 일을 조각으로 나눈다. NODES_PER_CALL 마다 멈춰 큐가 다른 일을 끼워 넣을 수 있게 한다. */
function* measure(body: unknown, roots: readonly Element[]): Generator<void, VisibleFields, void> {
  const keys = new Set<string>();
  let calls = 0;
  for (const root of outermost(roots)) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++calls % TEXT_NODES_PER_CALL === 0) yield;
      addTextKeys(keys, node.nodeValue ?? '');
    }
  }
  const result: VisibleFields = { visible: 0, total: 0, common: 0, paths: [], truncated: false };
  const seenPaths = new Set<string>();
  const stack: Array<[unknown, string]> = [[body, '$']];
  for (let nodes = 0; stack.length > 0; nodes++) {
    if (nodes >= MAX_NODES_PER_BODY) {
      result.truncated = true;
      break;
    }
    if (nodes % BODY_NODES_PER_CALL === 0) yield;
    const [value, path] = stack.pop()!;
    if (value !== null && typeof value === 'object') {
      const entries = Array.isArray(value)
        ? value.map((v, i) => [`[${i}]`, v] as const)
        : Object.entries(value).map(([k, v]) => [`.${k}`, v] as const);
      // 스택이라 뒤에서부터 꺼낸다. 경로 예시가 응답 순서대로 나오게 거꾸로 넣는다.
      for (let i = entries.length - 1; i >= 0; i--) stack.push([entries[i][1], `${path}${entries[i][0]}`]);
      continue;
    }
    if (value === undefined) continue;
    result.total++;
    if (!isDistinctive(value)) {
      result.common++;
      continue;
    }
    if (!keys.has(leafKey(value))) continue;
    result.visible++;
    const p = pattern(path);
    if (seenPaths.size < MAX_PATHS && !seenPaths.has(p)) {
      seenPaths.add(p);
      result.paths.push(p);
    }
  }
  return result;
}

/** 다 셀 때까지 돌린다(테스트·동기 호출용). */
export const countVisibleFields = (body: unknown, roots: readonly Element[]): VisibleFields => {
  const job = measure(body, roots);
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
};

/**
 * 유휴 큐에서 조각으로 센다. 큰 응답(수만 필드)도 메인 스레드를 한 번에 막지 않는다. 그만 셀 때는 돌려준 함수를 부른다.
 * 응답 객체를 Proxy 로 감싸 읽는 필드를 세지 않는 이유는 docs/CONTEXT.md 4.6 에 있다.
 */
export const measureVisibleFields = (body: unknown, roots: readonly Element[], onDone: (result: VisibleFields) => void): (() => void) => {
  let cancelled = false;
  const job = measure(body, roots);
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
