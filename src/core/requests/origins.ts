import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import type { Origin, RequestRecord } from './types.js';

const origins = new WeakMap<object, Origin>();

/** 응답 본문의 모든 객체·배열을 출처와 함께 등록한다. 이미 등록된 객체는 처음 출처를 유지한다. */
export const registerOrigins = (record: RequestRecord, body: unknown): void => {
  let count = 0;
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || count++ > MAX_NODES_PER_BODY || origins.has(value)) return;
    origins.set(value, { record, path });
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
    else Object.entries(value).forEach(([key, child]) => walk(child, `${path}.${key}`));
  };
  walk(body, '$');
};

export const getOrigin = (value: object): Origin | undefined => origins.get(value);
