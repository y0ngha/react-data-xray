// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Fiber } from '../../fiber/types.js';
import { recordMounts, resetMounts } from '../../render/mounts.js';
import { buildRequestSection } from '../../report/requestSection.js';
import type { RequestRecord } from '../types.js';

import { repeatCauseStep } from '../repeatCause.js';

const repeatCauseOf = (record: RequestRecord) => {
  const step = repeatCauseStep(record);
  while (!step());
  return record.repeatCause;
};

function Profile() {}
function Child() {}
function List() {}

const effect = (deps: unknown[]) => ({ memoizedState: { create: () => undefined, deps }, queue: null, next: null });
const fiber = (type: unknown, deps?: [unknown[], unknown[]], parent?: Fiber): Fiber => {
  const f = { tag: 0, type, return: parent ?? null, child: null, sibling: null, alternate: null } as unknown as Fiber;
  if (deps) {
    f.memoizedState = effect(deps[1]);
    f.alternate = { memoizedState: effect(deps[0]) } as unknown as Fiber;
  }
  return f;
};
const rec = (extra: Partial<RequestRecord>): RequestRecord => ({
  id: 2,
  kind: 'fetch',
  method: 'GET',
  url: '/a',
  status: 200,
  startedAt: 0,
  durationMs: 1,
  body: undefined,
  duplicateOf: 1,
  component: 'Profile',
  ...extra,
});

describe('중복 요청이 다시 나간 이유', () => {
  let container: HTMLElement | undefined;
  // 실제 React 가 컨테이너에 붙이는 키로 가짜 루트를 심는다.
  const mountRoot = (current: Fiber) => {
    container = document.body.appendChild(document.createElement('div'));
    (container as unknown as Record<string, unknown>)['__reactContainer$t'] = { tag: 3, stateNode: { current } };
  };
  beforeEach(resetMounts);
  afterEach(() => container?.remove());

  it('deps_change: 의존성 #1 이 1 에서 2 로 바뀌었으면 순번과 값을 담는다', () => {
    const root = fiber(undefined);
    root.child = fiber(Profile, [
      [1, 'x'],
      [2, 'x'],
    ]);
    mountRoot(root);
    const cause = repeatCauseOf(rec({}));
    expect(cause?.kind).toBe('deps');
    expect(cause?.detail).toContain('#1');
    expect(cause?.detail).toContain('1 → 2');
  });

  it('remount_parent: 의존성은 같고 부모가 key 를 바꿔 다시 마운트됐으면 부모 이름', () => {
    const list = fiber(List);
    const old = fiber(Child, undefined, list);
    const fresh = fiber(Child, undefined, list);
    recordMounts([], [{ fiber: old, parent: list, branch: list }], 0);
    recordMounts([{ fiber: old, parent: list }], [{ fiber: fresh, parent: list, branch: list }], 100);
    const cause = repeatCauseOf(rec({ component: 'Child', startedAt: 200 }));
    expect(cause).toEqual({ kind: 'remount', detail: '<Child> remount, parent <List> branch changed' });
  });

  it('strict: StrictMode 재실행은 strict 로 남고, 중복이 아니면 원인이 없다', () => {
    expect(repeatCauseOf(rec({ strictModeReplay: true }))?.kind).toBe('strict');
    expect(repeatCauseOf(rec({ duplicateOf: undefined }))).toBeUndefined();
  });

  it('보고서 endpoints[].repeatCauses 에 이유별 수가 들어간다', () => {
    const cause = { kind: 'deps' as const, detail: 'dep #1 changed (1 → 2), effect 1' };
    const section = buildRequestSection([rec({ id: 2, repeatCause: cause }), rec({ id: 3, repeatCause: cause })], new Map(), new Set());
    expect(section.endpoints[0].repeatCauses).toEqual([{ ...cause, count: 2 }]);
  });
});
