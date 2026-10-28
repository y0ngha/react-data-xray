import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import { enqueue } from '../scheduler/idleQueue.js';
import type { Origin, RequestRecord } from './types.js';

const origins = new WeakMap<object, Origin>();

// 한 step 에서 등록하는 노드 수. 시간은 공용 큐가 본다.
const NODES_PER_STEP = 256;

interface Work {
  record: RequestRecord;
  /** 앞에서부터 차례로(문서 순서) 꺼내도록 뒤집어 쌓는다. 같은 객체가 두 곳에 있으면 앞의 경로가 출처가 된다. */
  stack: Array<[object, string]>;
  count: number;
}

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

/** 응답 본문의 모든 객체·배열을 출처와 함께 공용 큐에 등록을 맡긴다(동기로는 아무것도 등록하지 않는다). 이미 등록된 객체는 처음 출처를 유지한다. */
export const registerOrigins = (record: RequestRecord, body: unknown): void => {
  if (body === null || typeof body !== 'object') return;
  const work: Work = { record, stack: [[body, '$']], count: 0 };
  enqueue(() => {
    for (let i = 0; i < NODES_PER_STEP; i++) if (step(work)) return true;
    return false;
  });
};

/** 등록이 끝난 것만 돌려준다. 남은 등록은 부르는 쪽이 flushQueue 로 먼저 마친다. */
export const getOrigin = (value: object): Origin | undefined => origins.get(value);
