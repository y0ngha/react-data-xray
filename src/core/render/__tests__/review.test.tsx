import { act, cleanup, render } from '@testing-library/react';
import { createContext, memo, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fiber } from '../../fiber/types.js';
import { buildRenderSection } from '../../report/renderSection.js';
import { createRecord } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { renderAdvice } from '../advice.js';
import { drain, groupRenders } from '../groups.js';
import { getRenderGroups, getTopRenders, ignoreComponent, renderGroupsSteps, resetRenderStats, setRenderMonitoring } from '../monitor.js';
import { getMountStats } from '../mounts.js';
import { summarize, WINDOW_MS } from '../summary.js';
import type { RenderEntry, RenderEvent, RenderReason } from '../types.js';

const event = (reason: RenderReason, time: number, extra: Partial<RenderEvent> = {}): RenderEvent => ({ time, reason, ...extra });
const entry = (name: string, events: RenderEvent[], extra: Partial<RenderEntry> = {}): RenderEntry => ({
  name,
  events,
  fiber: {},
  memoized: false,
  ...extra,
});

describe('원인 키(code-review PR2-2)', () => {
  it('causes_by_path: 목록 행마다 다른 /items/{id} 요청은 한 원인으로 합치지 않아 고리 조언이 오탐하지 않는다', () => {
    const rows = [1, 2, 3, 4, 5].map((id) => {
      const record = createRecord('fetch', 'GET', `/api/items/${id}`);
      record.stack = 'at useCard[useEffect()]';
      return entry('Card', [event('state', 1000, { cause: { record, via: 'direct' } })]);
    });
    const summaries = rows.map((e) => ({ ...e, ...summarize(e, 1000) }));
    expect(summaries[0].causes).toHaveLength(1);
    // 한 컴포넌트 안에서 여러 행의 응답으로 렌더돼도 따로 센다
    expect(
      summarize(
        entry(
          'List',
          rows.flatMap((r) => r.events),
        ),
        1000,
      ).causes,
    ).toHaveLength(5);
    const [group] = groupRenders(summaries);
    expect(group.causes).toHaveLength(5);
    expect(renderAdvice(group).join('\n')).not.toContain('고리');
  });

  it('같은 경로의 반복 요청은 한 원인으로 합친다', () => {
    const e = entry(
      'Card',
      [1, 2, 3].map((t) => event('state', 1000 + t, { cause: { record: createRecord('fetch', 'GET', '/api/items/9'), via: 'direct' } })),
    );
    expect(summarize(e, 2000).causes).toHaveLength(1);
    expect(summarize(e, 2000).causes[0].direct).toBe(3);
  });
});

describe('memo 건너뜀 분모(code-review PR3-8)', () => {
  it('memo_rendered: 마운트·자기 state·context 렌더는 rendered 에 세지 않는다', () => {
    const e = entry('Leaf', [event('mount', 1), event('state', 2), event('context', 3), event('parent', 4)], { memoized: true });
    expect(summarize(e, 10, 100).memo).toEqual({ skipped: 0, rendered: 1, neverSkippedProps: [] });
  });
});

describe('요약 캐시(code-review PR1-4, PR1-5)', () => {
  beforeEach(() => setRenderMonitoring(true));
  afterEach(() => {
    cleanup();
    resetRenderStats();
    setRenderMonitoring(false);
    vi.restoreAllMocks();
  });
  const Plain = () => <i>x</i>;

  it('two_windows: 10초 창과 넓은 창이 번갈아 불려도 기록이 그대로면 다시 요약하지 않는다', () => {
    render(<Plain />);
    flushQueue();
    const now = Date.now();
    const [top] = getTopRenders(1, now);
    // 10초 밖에 오래된 기록을 하나 더 둬 두 창의 내용이 다르게 한다.
    top.events.unshift(event('state', now - 30_000));
    const spy = vi.spyOn(top.events, 'filter');
    const call = () => {
      getTopRenders(20, now, undefined, WINDOW_MS);
      getTopRenders(20, now, undefined, 60_000);
    };
    call();
    const warm = spy.mock.calls.length;
    call();
    call();
    expect(spy.mock.calls.length).toBe(warm);
  });

  it('late_same_response: 나중에 붙은 sameResponseAs 가 캐시된 요약에 반영된다', () => {
    render(<Plain />);
    flushQueue();
    const now = Date.now();
    const [top] = getTopRenders(1, now);
    const record = createRecord('fetch', 'GET', '/api/late');
    top.events.push(event('state', now, { cause: { record, via: 'direct' } }));
    expect(getTopRenders(1, now)[0].causes[0].sameResponse).toBe(0);
    record.sameResponseAs = 1;
    expect(getTopRenders(1, now)[0].causes[0].sameResponse).toBe(1);
  });

  it('sort_only_over_limit: 상한 아래에서는 렌더 요약 목록을 정렬하지 않는다', () => {
    render(<Plain />);
    flushQueue();
    const sort = vi.spyOn(Array.prototype, 'sort');
    getRenderGroups(Date.now(), WINDOW_MS);
    const sortedEntries = sort.mock.contexts.filter((c) => Array.isArray(c) && c.some((x) => x && typeof x === 'object' && 'events' in x));
    expect(sortedEntries).toHaveLength(0);
  });
});

describe('유휴 조각(code-review PR1-3)', () => {
  beforeEach(() => setRenderMonitoring(true));
  afterEach(() => {
    cleanup();
    resetRenderStats();
    setRenderMonitoring(false);
  });
  const Cell = () => <td>c</td>;
  const Many = () => (
    <table>
      <tbody>
        <tr>
          {Array.from({ length: 1000 }, (_, i) => (
            <Cell key={i} />
          ))}
        </tr>
      </tbody>
    </table>
  );

  it('chunked: 인스턴스가 많으면 한 번에 끝내지 않고 여러 조각으로 나눠 돈다', () => {
    render(<Many />);
    flushQueue();
    const steps = renderGroupsSteps(Date.now(), WINDOW_MS);
    let yields = 0;
    let r = steps.next();
    while (!r.done) {
      yields++;
      r = steps.next();
    }
    expect(yields).toBeGreaterThan(5);
    expect(r.value.groups.find((g) => g.name === 'Cell')?.instances).toBe(1000);
    expect(drain(renderGroupsSteps(Date.now(), WINDOW_MS)).groups.length).toBe(r.value.groups.length);
  });
});

describe('그룹 키(code-review PR3-10)', () => {
  it('library_keys: 같은 패키지·이름이라도 그린 앱 컴포넌트가 다르면 키가 다르다', () => {
    const lib = (owner: string) => {
      const e = entry('Btn', [event('state', 1)], { package: 'ui-kit', owner: { name: owner } });
      return { ...e, ...summarize(e, 10) };
    };
    const app = (name: string) => {
      const e = entry(name, [event('state', 1)]);
      return { ...e, ...summarize(e, 10) };
    };
    const groups = groupRenders([lib('A'), lib('B')]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
    // 앱 그룹이 있으면 접히고, 키는 그룹마다 있다
    expect(groupRenders([app('A'), lib('A')]).every((g) => !!g.key)).toBe(true);
  });
});

describe('보고서 stateChanges(code-review PR3 덧붙임)', () => {
  beforeEach(() => setRenderMonitoring(true));
  afterEach(() => {
    cleanup();
    resetRenderStats();
    setRenderMonitoring(false);
  });
  let bump: () => void = () => {};
  const Stateful = () => {
    const [n, setN] = useState(0);
    useEffect(() => {
      bump = () => setN((v) => v + 1);
    }, []);
    return <i>{n}</i>;
  };

  it('no_hookindex: hookIndex 는 보고서 JSON 에 새지 않는다', () => {
    render(<Stateful />);
    act(() => bump());
    flushQueue();
    const c = buildRenderSection(true, Date.now()).components.find((x) => x.name === 'Stateful')!;
    expect(c.stateChanges.length).toBeGreaterThan(0);
    expect(JSON.stringify(c.stateChanges)).not.toContain('hookIndex');
  });
});

describe('마운트 통계는 위치별(code-review PR3 약점)', () => {
  beforeEach(() => setRenderMonitoring(true));
  afterEach(() => {
    cleanup();
    resetRenderStats();
    setRenderMonitoring(false);
  });
  let setN: (n: number) => void = () => {};
  const Child = () => <i>c</i>;
  const TwoPlaces = () => {
    const [n, set] = useState(0);
    useEffect(() => {
      setN = set;
    }, []);
    return (
      <>
        <Child key={n} />
        <Child key={`b${n}`} />
      </>
    );
  };

  it('per_location: 같은 이름의 두 위치 그룹이 각자 자기 위치의 마운트를 싣는다', () => {
    render(<TwoPlaces />);
    act(() => setN(1));
    flushQueue();
    const comps = buildRenderSection(true, Date.now()).components.filter((x) => x.name === 'Child');
    expect(comps.map((c) => c.mounts?.mounts)).toEqual([2, 2]);
    expect(getMountStats('Child').mounts).toBe(4);
  });
});

describe('commit 방문·언마운트(code-review PR3-4, 5, 6, ponytail PR3-6)', () => {
  beforeEach(() => setRenderMonitoring(true));
  afterEach(() => {
    cleanup();
    resetRenderStats();
    setRenderMonitoring(false);
  });

  it('fresh_cut: 렌더하지 않은 composite 아래의 bailout memo 는 건너뜀으로 세지 않는다', () => {
    const Ctx = createContext(0);
    const Leaf = memo(function Leaf() {
      return <i>leaf</i>;
    });
    const Consumer = () => <b>{useContext(Ctx)}</b>;
    const Mid = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
    const stable = (
      <Mid>
        <Leaf />
        <Consumer />
      </Mid>
    );
    let bump: () => void = () => {};
    const App = () => {
      const [n, setN] = useState(0);
      useEffect(() => {
        bump = () => setN((v) => v + 1);
      }, []);
      return <Ctx.Provider value={n}>{stable}</Ctx.Provider>;
    };
    render(<App />);
    act(() => bump());
    act(() => bump());
    flushQueue();
    const leaf = getRenderGroups(Date.now(), WINDOW_MS).groups.find((g) => g.name === 'Leaf');
    expect(leaf?.memo?.skipped ?? 0).toBe(0);
  });

  it('own_ignored: 패널(ignoreComponent) 자신이 있는 서브트리가 지워져도 그 안 컴포넌트를 언마운트로 세지 않는다', () => {
    const Panel = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
    const Inner = () => <i>inner</i>;
    ignoreComponent(Panel);
    const { unmount } = render(
      <Panel>
        <Inner />
      </Panel>,
    );
    unmount();
    flushQueue();
    expect(getMountStats('Inner').unmounts).toBe(0);
  });

  it('devtools_root_unmount: framework devtools root 에서 지운 것이 다음 앱 commit 에 섞이지 않는다', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const Overlay = () => <i>overlay</i>;
    let bump: () => void = () => {};
    const App = () => {
      const [n, setN] = useState(0);
      useEffect(() => {
        bump = () => setN((v) => v + 1);
      }, []);
      return <b>{n}</b>;
    };
    render(<App />);
    const portal = document.createElement('nextjs-portal');
    document.body.append(portal);
    const root = createRoot(portal);
    await act(async () => root.render(<Overlay />));
    await act(async () => root.unmount());
    act(() => bump());
    flushQueue();
    expect(getMountStats('Overlay').unmounts).toBe(0);
    portal.remove();
  });

  it('sibling_walk: 같은 부모 아래 지워진 형제마다 루트까지 거슬러 올라가지 않는다', () => {
    let typeReads = 0;
    const node = (parent: Fiber | null): Fiber => {
      const f = { tag: 0, return: parent } as unknown as Fiber;
      Object.defineProperty(f, 'type', {
        get: () => {
          typeReads++;
          return () => null;
        },
      });
      return f;
    };
    let top: Fiber | null = null;
    for (let i = 0; i < 50; i++) top = node(top);
    const hook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: { onCommitFiberUnmount: (id: number, f: Fiber) => void } })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
    for (let i = 0; i < 20; i++) hook.onCommitFiberUnmount(1, node(top));
    // 처음 한 번만 50칸을 오르고, 나머지 형제는 부모의 판정을 쓴다(형제마다 오르면 1000 번 넘게 읽는다).
    expect(typeReads).toBeLessThan(200);
  });
});
