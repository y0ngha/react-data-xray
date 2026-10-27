import { describe, expect, it } from 'vitest';

import type { Fiber } from '../../fiber/types.js';
import { createRecord, finishRecord, registerBody } from '../../requests/store.js';
import { renderAdvice } from '../advice.js';
import { groupRenders, sortRenderGroups, type RenderGroup } from '../groups.js';
import { causeOf, findRecentResponse } from '../networkCause.js';
import { changedState, sameContent } from '../renderReason.js';
import { summarize } from '../summary.js';
import { RENDER_REASONS, type RenderEntry, type RenderReason, type RenderSummary } from '../types.js';

describe('sameContent', () => {
  it('평범한 객체·배열만 내용으로 비교하고 Date 는 값으로 비교한다', () => {
    expect(sameContent({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameContent(new Date(1), new Date(1))).toBe(true);
    expect(sameContent(new Map([[1, 1]]), new Map([[1, 2]]))).toBe(false);
    expect(sameContent(1, 1)).toBe(false);
    expect(sameContent(null, {})).toBe(false);
  });

  it('20KB 를 넘거나 순환하는 값은 같다고 보지 않는다', () => {
    const big = { s: 'x'.repeat(20_001) };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sameContent(big, { ...big })).toBe(false);
    expect(sameContent(circular, circular)).toBe(false);
  });
});

describe('changedState', () => {
  it('effect·memo 훅의 새 객체는 state 변경으로 보지 않는다', () => {
    const hook = (memoizedState: unknown, queue: unknown = null, next: unknown = null) => ({ memoizedState, queue, next });
    const effect = { tag: 1, create: () => undefined };
    const prev = { tag: 0, memoizedState: hook([1, []], null, hook({ ...effect })) } as unknown as Fiber;
    const next = { tag: 0, memoizedState: hook([1, []], null, hook({ ...effect })) } as unknown as Fiber;
    expect(changedState(next, prev)).toEqual([]);
  });
});

describe('networkCause', () => {
  const respond = (url: string, body: unknown) => {
    const record = createRecord('fetch', 'GET', url);
    finishRecord(record, 200);
    registerBody(record, body);
    return record;
  };

  it('3초 안에 도착한 응답의 객체만 원인으로 본다', () => {
    const body = { item: { id: 1 } };
    const record = respond('/api/c', body);
    const arrived = record.startedAt + record.durationMs;
    expect(findRecentResponse([{ wrap: body.item }], arrived + 100)).toBe(record);
    expect(findRecentResponse([body.item], arrived + 5000)).toBeUndefined();
    expect(findRecentResponse([body.item], arrived - 1)).toBeUndefined();
    expect(findRecentResponse([1, null, document.createElement('div')], arrived)).toBeUndefined();
  });

  it('자기 변경값에 응답이 없으면 조상의 원인을 이어받되, 자기 state 변경 렌더는 이어받지 않는다', () => {
    const record = respond('/api/p', { x: { id: 2 } });
    const inherited = { record, via: 'direct' as const };
    expect(causeOf({ reason: 'parent', changed: [] }, inherited, Date.now())).toEqual({ record, via: 'parent' });
    expect(causeOf({ reason: 'state', changed: [{ y: 1 }] }, inherited, Date.now())).toBeUndefined();
    expect(causeOf({ reason: 'parent', changed: [] }, undefined, Date.now())).toBeUndefined();
  });
});

const entry = (name: string, events: RenderEntry['events'], memoized = false): RenderEntry => ({ name, events, fiber: {}, memoized });
const event = (reason: RenderReason, extra: Partial<RenderEntry['events'][number]> = {}) => ({ time: 1000, reason, ...extra });

describe('summary, groups, advice', () => {
  it('최근 10초 렌더를 이유별로 세고, 이미 memo 인 컴포넌트의 부모 렌더는 줄일 수 있는 렌더에서 뺀다', () => {
    const record = createRecord('fetch', 'GET', '/api/s');
    const events = [
      event('parent'),
      event('same-content', { keys: ['style'], ms: 2 }),
      event('state', { cause: { record, via: 'direct' } }),
      event('mount', { time: -20_000 }),
    ];
    expect(summarize(entry('A', events), 1000)).toMatchObject({ recent: 3, ms: 2, avoidable: 2, network: 1, sameContentKeys: ['style'] });
    expect(summarize(entry('A', events, true), 1000).avoidable).toBe(1);
  });

  it('같은 이름의 컴포넌트를 합치고 원인 요청도 엔드포인트별로 합친다', () => {
    const record = createRecord('fetch', 'GET', '/api/g');
    const one = summarize(entry('Row', [event('parent', { cause: { record, via: 'parent' } })]), 1000);
    const two = summarize(entry('Row', [event('new-callback', { keys: ['onClick'], cause: { record, via: 'direct' } })]), 1000);
    const other = summarize(entry('Other', [event('state')]), 1000);
    const groups = groupRenders([
      { ...entry('Row', []), ...one },
      { ...entry('Row', []), ...two },
      { ...entry('Other', []), ...other },
    ]);
    const row = groups.find((g) => g.name === 'Row')!;
    expect(row).toMatchObject({ instances: 2, recent: 2, avoidable: 2, callbackKeys: ['onClick'] });
    expect(row.causes).toEqual([{ record, direct: 1, parent: 1 }]);
    expect(sortRenderGroups(groups, 'avoidable')[0].name).toBe('Row');
    expect(sortRenderGroups(groups, 'count').map((g) => g.name)).toEqual(['Row', 'Other']);
    expect(sortRenderGroups(groups, 'time')).toHaveLength(2);
  });

  it('이유마다 고치는 방법을 알려 주고, memo 인 컴포넌트에는 React.memo 를 권하지 않는다', () => {
    const base: RenderSummary = {
      recent: 1,
      last: 0,
      ms: 0,
      reasons: Object.fromEntries(RENDER_REASONS.map((r) => [r, 1])) as RenderSummary['reasons'],
      avoidable: 0,
      sameContentKeys: ['style'],
      callbackKeys: ['onClick'],
      contextKeys: ['Theme'],
      memoized: false,
      network: 0,
      causes: [],
    };
    const group: RenderGroup = { ...base, name: 'X', instances: 1, fiber: {} };
    const advice = renderAdvice(group);
    expect(advice).toHaveLength(4);
    expect(advice.join()).toContain('props.style');
    expect(advice.join()).toContain('useCallback');
    expect(advice.join()).toContain('Theme');
    expect(renderAdvice({ ...group, memoized: true }).some((a) => a.includes('React.memo 로 감싸면'))).toBe(false);
    expect(renderAdvice({ ...group, reasons: { ...group.reasons, 'same-content': 0, 'new-callback': 0, parent: 0, context: 0 } })).toEqual(
      [],
    );
  });
});
