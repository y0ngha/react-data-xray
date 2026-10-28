import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import type { Origin, RequestRecord } from './types.js';

const origins = new WeakMap<object, Origin>();

// 앱의 res.json()·JSON.parse 안에서 쓰는 시간. 큰 응답(5만 객체)을 다 등록하면 파싱의 3~6배가 걸려 앱이 데이터를 늦게 받는다.
const SYNC_MS = 2;
const SLICE_MS = 8;
// 시각을 이 노드 수마다 한 번 본다(매번 보면 그 자체가 비싸다).
const CHECK_EVERY = 256;

interface Work {
  record: RequestRecord;
  /** 앞에서부터 차례로(문서 순서) 꺼내도록 뒤집어 쌓는다. 같은 객체가 두 곳에 있으면 앞의 경로가 출처가 된다. */
  stack: Array<[object, string]>;
  count: number;
}

// 응답이 들어온 순서대로 한다. 먼저 받은 응답의 객체가 처음 출처로 남는다.
const queue: Work[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** 노드 하나를 등록한다. 이 응답의 일이 끝났으면 true */
const step = (work: Work): boolean => {
  const next = work.stack.pop();
  if (!next || work.count++ > MAX_NODES_PER_BODY) return true;
  const [value, path] = next;
  if (origins.has(value)) return work.stack.length === 0;
  origins.set(value, { record: work.record, path });
  const children: Array<[object, string]> = [];
  const add = (child: unknown, childPath: string) => {
    if (child !== null && typeof child === 'object') children.push([child, childPath]);
  };
  if (Array.isArray(value)) value.forEach((item, i) => add(item, `${path}[${i}]`));
  else Object.entries(value).forEach(([key, child]) => add(child, `${path}.${key}`));
  for (let i = children.length - 1; i >= 0; i--) work.stack.push(children[i]);
  return work.stack.length === 0;
};

const run = (limitMs: number): void => {
  const started = performance.now();
  let n = 0;
  while (queue.length > 0) {
    if (++n % CHECK_EVERY === 0 && performance.now() - started >= limitMs) break;
    if (step(queue[0])) queue.shift();
  }
  clearTimeout(timer);
  timer = queue.length > 0 ? setTimeout(() => run(SLICE_MS), 0) : undefined;
};

/** 응답 본문의 모든 객체·배열을 출처와 함께 등록한다. 이미 등록된 객체는 처음 출처를 유지한다. 큰 응답의 나머지는 백그라운드에서 한다. */
export const registerOrigins = (record: RequestRecord, body: unknown): void => {
  if (body === null || typeof body !== 'object') return;
  queue.push({ record, stack: [[body, '$']], count: 0 });
  run(SYNC_MS);
};

/** 남은 등록을 먼저 마쳐, 조회 결과가 등록을 미루기 전과 같게 한다. */
export const getOrigin = (value: object): Origin | undefined => {
  if (queue.length > 0) run(Infinity);
  return origins.get(value);
};
