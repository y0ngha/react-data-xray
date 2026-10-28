import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as mountsModule from '../../render/mounts.js';

import type { Fiber } from '../../fiber/types.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { getEndpointStats } from '../endpointStats.js';
import { maskEndpoint } from '../requestKey.js';
import { repeatCauseStep } from '../repeatCause.js';
import { createRecord, subscribe } from '../store.js';
import type { RequestRecord } from '../types.js';

const mounts = { remounts: [] as Array<{ parent: string; count: number; lastAt: number; cause?: 'type-changed' }> };
vi.spyOn(mountsModule, 'getMountStats').mockImplementation(() => ({ mounts: 2, unmounts: 1, remounts: mounts.remounts }));

const rec = (extra: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 2,
  kind: 'fetch',
  method: 'GET',
  url: '/a',
  status: 200,
  startedAt: 10_000,
  durationMs: 1,
  body: undefined,
  duplicateOf: 1,
  component: 'Child',
  ...extra,
});
const run = (record: RequestRecord) => {
  const step = repeatCauseStep(record);
  while (!step());
  return record.repeatCause;
};

describe('재마운트 원인 (PR4-7)', () => {
  beforeEach(() => {
    mounts.remounts = [];
  });

  it('요청 시작 전 5초 안의 재마운트만 원인으로 쓴다', () => {
    mounts.remounts = [{ parent: 'List', count: 1, lastAt: 9_000 }];
    expect(run(rec())?.detail).toBe('<Child> 재마운트, 부모 <List> 의 분기 변경');
    mounts.remounts = [{ parent: 'List', count: 1, lastAt: 4_000 }]; // 6초 전
    expect(run(rec())).toBeUndefined();
    mounts.remounts = [{ parent: 'List', count: 1, lastAt: 10_500 }]; // 요청 뒤
    expect(run(rec())).toBeUndefined();
  });

  it('type-changed 는 렌더 중 컴포넌트 정의 처방을 쓴다', () => {
    mounts.remounts = [{ parent: 'List', count: 3, lastAt: 9_900, cause: 'type-changed' }];
    expect(run(rec())?.detail).toContain('렌더 중 컴포넌트 정의');
  });
});

describe('repeatCause 조각 (PR4-10)', () => {
  it('fiber 가 많으면 여러 step 으로 나눠 훑고 끝나면 store 에 알린다', () => {
    // 실제 React 가 컨테이너에 붙이는 키로 fiber 1000개짜리 루트를 심는다.
    const root = { tag: 3, type: undefined, return: null, child: null, sibling: null, alternate: null } as unknown as Fiber;
    let tail = root;
    for (let i = 0; i < 1000; i++) {
      const next = { tag: 0, type: function Other() {}, return: tail, child: null, sibling: null, alternate: null } as unknown as Fiber;
      tail.child = next;
      tail = next;
    }
    const container = document.body.appendChild(document.createElement('div'));
    (container as unknown as Record<string, unknown>)['__reactContainer$t'] = { tag: 3, stateNode: { current: root } };
    const record = rec();
    const step = repeatCauseStep(record);
    let calls = 1;
    while (!step()) calls++;
    expect(calls).toBeGreaterThan(1);
    container.remove();

    const first = createRecord('fetch', 'GET', '/api/notify');
    const second = createRecord('fetch', 'GET', '/api/notify');
    second.strictModeReplay = true;
    second.component = 'Child';
    const seen: Array<unknown> = [];
    const unsubscribe = subscribe(() => seen.push(second.repeatCause));
    flushQueue();
    flushQueue();
    unsubscribe();
    expect(first.id).toBeLessThan(second.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toMatchObject({ kind: 'strict' });
  });
});

describe('엔드포인트 집계 (cleanup)', () => {
  it('keyOf 는 기록마다 한 번만 부른다', () => {
    const records = [rec({ id: 1, status: 503, duplicateOf: undefined }), rec({ id: 2 })];
    const keyOf = vi.fn<(r: RequestRecord) => string>((r) => r.url);
    getEndpointStats(records, new Map(), keyOf);
    expect(keyOf).toHaveBeenCalledTimes(records.length);
  });

  it('maskEndpoint: 묶기 전에 저장한 엔드포인트를 지금 형식으로 바꾼다', () => {
    expect(maskEndpoint('GET /items/5')).toBe('GET /items/:id');
    expect(maskEndpoint('GET /items/:id')).toBe('GET /items/:id');
    expect(maskEndpoint('POST /a/12 (action abc)')).toBe('POST /a/:id (action abc)');
  });
});
