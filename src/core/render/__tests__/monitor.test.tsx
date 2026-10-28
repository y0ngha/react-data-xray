import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  createContext,
  memo,
  useContext,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushQueue } from '../../scheduler/idleQueue.js';
import { DEFAULT_BODY, flush } from '../../../testing/fetchMock.js';
import {
  getCommits as rawCommits,
  getRenderInfo as rawInfo,
  getTopRenders as rawTop,
  ignoreComponent,
  reportWindowMs,
  resetRenderStats,
  setRenderMonitoring,
  subscribeCommits,
} from '../monitor.js';
import { renderAdvice } from '../advice.js';
import { groupRenders } from '../groups.js';

const getTopRenders = (...a: Parameters<typeof rawTop>) => (flushQueue(), rawTop(...a));
const getCommits = () => (flushQueue(), rawCommits());
const getRenderInfo = (...a: Parameters<typeof rawInfo>) => (flushQueue(), rawInfo(...a));
const byName = () => Object.fromEntries(getTopRenders(200).map((e) => [e.name, e]));

/** 누를 때마다 n 을 올리는 부모. 자식은 children 으로 받아 n 을 넘겨준다. */
function Counter({ children }: { children: (n: number) => ReactNode }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <button onClick={() => setN((v) => v + 1)}>bump</button>
      {children(n)}
    </div>
  );
}

const bump = (times = 1) => Array.from({ length: times }, () => fireEvent.click(screen.getByText('bump')));

beforeEach(() => setRenderMonitoring(true));
afterEach(() => setRenderMonitoring(false));

describe('렌더 감시', () => {
  it('실제로 렌더된 컴포넌트만 세고, memo 로 bailout 한 자식은 세지 않는다', () => {
    const Child = memo(function Child() {
      return <span>child</span>;
    });
    render(
      <Counter>
        {(n) => (
          <>
            <i>{n}</i>
            <Child />
          </>
        )}
      </Counter>,
    );
    bump(2);
    expect(byName().Counter.recent).toBe(3);
    expect(byName().Child.recent).toBe(1);
    const counter = getTopRenders(50).find((e) => e.name === 'Counter')!;
    expect(getRenderInfo(counter.fiber)).toMatchObject({ recent: 3 });
    expect(getRenderInfo({ alternate: null })).toBeNull();
  });

  it('형제가 번갈아 업데이트돼도 렌더를 빠짐없이 센다', () => {
    function Sib({ label }: { label: string }) {
      const [n, setN] = useState(0);
      return <button onClick={() => setN((v) => v + 1)}>{`${label}${n}`}</button>;
    }
    render(
      <div>
        <Sib label="a" />
        <Sib label="b" />
      </div>,
    );
    Array.from({ length: 10 }, (_, i) => {
      fireEvent.click(screen.getByText(`a${i}`));
      fireEvent.click(screen.getByText(`b${i}`));
      return i;
    });
    expect(
      getTopRenders(200)
        .filter((e) => e.name === 'Sib')
        .map((e) => e.recent),
    ).toEqual([11, 11]);
  });

  it('렌더 이유를 state, props, 같은 내용 새 참조, 새 콜백, 부모 렌더로 나눈다', () => {
    const Static = () => <i>static</i>;
    const Rows = ({ items, label }: { items: number[]; label: string }) => <b>{`${label}${items.length}`}</b>;
    const Btn = ({ onClick, style }: { onClick: () => void; style: object }) => (
      <button type="button" aria-label="action" style={style} onClick={onClick} />
    );
    function Page() {
      const [n, setN] = useState(0);
      return (
        <div>
          <button onClick={() => setN((v) => v + 1)}>bump</button>
          <Static />
          <Rows items={[1, 2, 3]} label={n > 1 ? 'b' : 'a'} />
          <Btn onClick={() => undefined} style={{ color: 'red' }} />
        </div>
      );
    }
    render(<Page />);
    bump(2);
    const r = byName();
    expect(r.Page.reasons).toMatchObject({ mount: 1, state: 2 });
    expect(r.Static.reasons).toMatchObject({ mount: 1, parent: 2 });
    expect(r.Rows.reasons).toMatchObject({ mount: 1, 'same-content': 1, props: 1 });
    expect(r.Rows.sameContentKeys).toEqual(['items']);
    expect(r.Btn.reasons).toMatchObject({ 'new-callback': 2 });
    expect(r.Btn.callbackKeys).toEqual(['onClick', 'style']);
    expect(r.Static.avoidable).toBe(2);
  });

  it('context 값이 바뀐 렌더는 context 로 분류하고, 이미 memo 인 컴포넌트의 부모 렌더는 줄일 수 있다고 하지 않는다', () => {
    const Theme = createContext('light');
    Theme.displayName = 'Theme';
    const Consumer = memo(function Consumer() {
      return <span>{useContext(Theme)}</span>;
    });
    function App() {
      const [theme, setTheme] = useState('light');
      return (
        <Theme.Provider value={theme}>
          <button onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>bump</button>
          <Consumer />
        </Theme.Provider>
      );
    }
    render(<App />);
    bump();
    expect(byName().Consumer).toMatchObject({ contextKeys: ['Theme'], avoidable: 0, memoized: true });
    expect(byName().Consumer.reasons).toMatchObject({ mount: 1, context: 1, parent: 0 });
  });

  it('Map·Set 처럼 JSON 으로 비교할 수 없는 props 와 children 이 섞인 경우를 바르게 나눈다', () => {
    const View = ({ tags }: { tags: Set<string> }) => <span>{tags.size}</span>;
    const Box = ({ style, children }: { style: object; children: ReactNode }) => <div style={style}>{children}</div>;
    render(
      <Counter>
        {(n) => (
          <>
            <View tags={new Set(n > 0 ? ['a', 'b'] : ['a'])} />
            <Box style={{ margin: 1 }}>
              <i>{n}</i>
            </Box>
          </>
        )}
      </Counter>,
    );
    bump();
    expect(byName().View.reasons).toMatchObject({ props: 1, 'same-content': 0 });
    expect(byName().Box.reasons).toMatchObject({ 'same-content': 1 });
  });

  it('useDeferredValue 의 지연 렌더는 부모 렌더가 아니라 state 로 분류한다', async () => {
    function Search() {
      const [q, setQ] = useState('');
      const deferred = useDeferredValue(q);
      return <input aria-label="q" value={deferred} onChange={(e) => setQ(e.target.value)} />;
    }
    render(<Search />);
    await act(async () => fireEvent.change(screen.getByLabelText('q'), { target: { value: 'abc' } }));
    expect(byName().Search.reasons.parent).toBe(0);
  });

  it('commit 시각과 렌더 수를 기록하고 구독자에게 알리며, 무시한 컴포넌트는 세지 않는다', () => {
    const Hidden = () => <span>hidden</span>;
    ignoreComponent(Hidden);
    let notified = 0;
    const unsubscribe = subscribeCommits(() => {
      notified++;
    });
    render(<Counter>{() => <Hidden />}</Counter>);
    bump();
    flushQueue();
    unsubscribe();
    expect(byName().Hidden).toBeUndefined();
    expect(getCommits().length).toBeGreaterThan(0);
    expect(notified).toBeGreaterThan(0);
  });

  it('감시를 끄면 기록을 비우고 더 세지 않는다', () => {
    render(<Counter>{() => null}</Counter>);
    setRenderMonitoring(false);
    expect(getTopRenders()).toEqual([]);
    expect(getCommits()).toEqual([]);
    bump();
    expect(getTopRenders()).toEqual([]);
    setRenderMonitoring(true);
  });
});

describe('렌더의 네트워크 원인', () => {
  it('응답을 state 로 받은 렌더는 직접, 그 데이터로 mount 된 자식도 네트워크 원인이다', async () => {
    const Row = ({ item }: { item: { title: string } }) => <li>{item.title}</li>;
    function List() {
      const [items, setItems] = useState<Array<{ id: number; title: string }>>([]);
      useEffect(() => {
        void fetch('/api/items')
          .then((r) => r.json())
          .then((json: typeof DEFAULT_BODY) => setItems(json.data.list));
      }, []);
      return (
        <ul>
          {items.map((i) => (
            <Row key={i.id} item={i} />
          ))}
        </ul>
      );
    }
    render(<List />);
    await act(flush);
    await act(flush);
    const list = byName().List;
    expect(list.network).toBe(1);
    expect(list.causes[0]).toMatchObject({ direct: 1, parent: 0 });
    expect(list.causes[0].record.url).toBe('/api/items');
    // 행 두 개가 각각 응답 항목을 props 로 받으며 mount 됐다.
    expect(
      getTopRenders(50)
        .filter((e) => e.name === 'Row')
        .map((e) => e.network),
    ).toEqual([1, 1]);
  });

  it('응답을 가공해 state 에 넣어도 응답 직후의 렌더로 잇고, effect 에서 거듭 다시 요청하면 의존성 고리라고 짚는다', async () => {
    function Notices() {
      const [items, setItems] = useState<Array<{ id: number }>>([]);
      const runs = useRef(0);
      // 이 effect 가 채우는 state 를 읽고 의존성에도 넣은 실수(받은 개수를 서버에 알린다). 테스트가 끝나도록 6번에서 멈춘다.
      useEffect(() => {
        if (runs.current++ >= 6) return;
        void fetch('/api/notices', { headers: { 'x-known-count': String(items.length) } })
          .then((r) => r.json())
          .then((json: typeof DEFAULT_BODY) => setItems(json.data.list.map((x) => ({ id: x.id }))));
      }, [items]);
      return <p>{items.length}</p>;
    }
    render(<Notices />);
    for (let i = 0; i < 8; i++) await act(flush);
    const notices = groupRenders(getTopRenders(200), 0).find((g) => g.name === 'Notices')!;
    expect(notices.causes[0].record.url).toBe('/api/notices');
    expect(notices.causes[0].timing).toBeGreaterThanOrEqual(5);
    expect(notices.network).toBeGreaterThanOrEqual(5);
    expect(renderAdvice(notices)[0]).toContain('응답 → state → effect → 다시 요청 고리');
  });

  it('네트워크와 무관한 state 변경 렌더는 원인을 붙이지 않는다', () => {
    render(<Counter>{(n) => <i>{n}</i>}</Counter>);
    bump();
    expect(byName().Counter).toMatchObject({ network: 0, recent: 2 });
  });

  it('거르는 조건은 상위 몇 개로 자르기 전에 적용한다(분석 대상 안의 렌더가 빠지지 않게)', () => {
    function Busy({ n }: { n: number }) {
      return <b>{n}</b>;
    }
    function Quiet({ n }: { n: number }) {
      return <s>{n % 2}</s>;
    }
    render(<Counter>{(n) => (n % 3 === 0 ? <Quiet n={n} /> : <Busy n={n} />)}</Counter>);
    bump(6);
    expect(getTopRenders(1)[0].name).not.toBe('Quiet');
    expect(getTopRenders(1, Date.now(), (e) => e.name === 'Quiet').map((e) => e.name)).toEqual(['Quiet']);
  });

  /** 부모(Counter) state 로 두 번 렌더된 Leaf 의 렌더 기록 */
  const renderLeaf = () => {
    function Leaf() {
      return <em>leaf</em>;
    }
    function Middle() {
      return <Leaf />;
    }
    render(<Counter>{() => <Middle />}</Counter>);
    bump(2);
    return getTopRenders(200).find((e) => e.name === 'Leaf')!;
  };
  it('부모를 따라 렌더된 자손은 렌더를 시작한 조상(이름·이유)을 남긴다', () => {
    expect(renderLeaf().origins).toEqual([{ name: 'Counter', reason: 'state', count: 2 }]);
  });

  // React 18 은 _debugSource, React 19 는 _debugStack 에서 읽는다(pnpm test:react19 가 19 쪽을 본다).
  it('자기를 그리는 JSX 위치(Middle 안의 <Leaf />)를 남긴다', () => {
    expect(renderLeaf().location).toMatch(/monitor\.test\.tsx:\d+$/);
  });
});

describe('분석 미루기', () => {
  it('commit_defers_analysis: commit 직후엔 결과가 없고 flush 뒤 생기며 리스너는 1회', () => {
    flushQueue();
    let n = 0;
    const off = subscribeCommits(() => n++);
    render(<Counter>{() => null}</Counter>);
    expect(rawTop()).toEqual([]);
    expect(rawCommits().length).toBe(0);
    flushQueue();
    off();
    expect(rawCommits().length).toBe(1);
    expect(n).toBe(1);
    expect(rawTop()[0].reasons).toMatchObject({ mount: 1 });
  });

  it('snapshot_survives_next_render: 연달아 렌더해도 첫 변경의 from/to 가 남는다', () => {
    function Tick() {
      const [n, setN] = useState(0);
      return <button onClick={() => setN((v) => v + 10)}>tick {n}</button>;
    }
    render(<Tick />);
    flushQueue();
    resetRenderStats();
    fireEvent.click(screen.getByText(/^tick/));
    fireEvent.click(screen.getByText(/^tick/));
    const t = getTopRenders();
    const hooks = t.find((e) => e.name === 'Tick')!.events.map((e) => e.hooks);
    expect(hooks[0]).toMatchObject([{ from: '0', to: '10' }]);
    expect(hooks[1]).toMatchObject([{ from: '10', to: '20' }]);
  });

  it('inheritance_kept: 부모 state 렌더의 자식은 reason parent, origin 은 부모', () => {
    const Kid = () => <i>kid</i>;
    render(<Counter>{() => <Kid />}</Counter>);
    bump();
    const kid = getTopRenders(50).find((e) => e.name === 'Kid')!;
    expect(kid.events[1]).toMatchObject({ reason: 'parent', origin: { name: 'Counter', reason: 'state' } });
  });

  it('unmount_before_flush: 분석 전에 언마운트돼 alternate 가 비워져도 같은 컴포넌트는 항목 하나', () => {
    const { unmount } = render(<Counter>{() => null}</Counter>);
    flushQueue();
    bump();
    unmount();
    const counters = getTopRenders(50).filter((e) => e.name === 'Counter');
    expect(counters.length).toBe(1);
    expect(counters[0].events.map((e) => e.reason)).toEqual(['mount', 'state']);
  });

  it('listener_per_commit: commit 3번 → 리스너 3번, 순서대로', () => {
    const seen: number[] = [];
    const off = subscribeCommits(() => seen.push(rawCommits()[rawCommits().length - 1].id));
    render(<Counter>{() => null}</Counter>);
    bump(2);
    flushQueue();
    off();
    expect(seen.length).toBe(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('측정 구간', () => {
  it('reset 뒤에는 보고서 구간이 reset 부터라, 10초가 지난 시나리오 렌더도 센다', () => {
    render(<Counter>{() => null}</Counter>);
    bump();
    resetRenderStats();
    bump(2);
    const later = Date.now() + 30_000;
    expect(getTopRenders(50, later)).toEqual([]);
    expect(reportWindowMs(later)).toBeGreaterThanOrEqual(30_000);
    expect(getTopRenders(50, later, undefined, reportWindowMs(later)).find((e) => e.name === 'Counter')?.recent).toBe(2);
  });
});

describe('바뀐 state 와 렌더 시작점의 영향', () => {
  it('state 로 렌더되면 바뀐 훅의 종류·순서·값을 남기고, 일정한 간격이면 그 간격을 알린다', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      function Ticker() {
        useEffect(() => undefined, []);
        const [left, setLeft] = useState(3000);
        return <button onClick={() => setLeft((v) => v - 1000)}>tick {left}</button>;
      }
      render(<Ticker />);
      [1, 2, 3].forEach(() => {
        vi.setSystemTime(Date.now() + 1000);
        fireEvent.click(screen.getByText(/^tick/));
      });
      const ticker = getTopRenders(200).find((e) => e.name === 'Ticker')!;
      expect(ticker.stateHooks).toEqual([
        { label: 'useState #2', hookIndex: 2, count: 3, intervalMs: 1000, last: { from: '1000', to: '0' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('useSyncExternalStore 처럼 훅 칸을 둘 만드는 훅이 있어도, 코드에서 부른 순서로 훅을 가리킨다', () => {
    const noop = () => () => undefined;
    const Mode = createContext('dark');
    function Store() {
      useSyncExternalStore(noop, () => 1);
      const theme = useContext(Mode);
      const [n, setN] = useState(0);
      return (
        <button onClick={() => setN((v) => v + 1)}>
          store {n} {theme}
        </button>
      );
    }
    render(<Store />);
    fireEvent.click(screen.getByText(/^store/));
    const store = getTopRenders(200).find((e) => e.name === 'Store')!;
    expect(store.stateHooks.map((h) => h.label)).toEqual(['useState #3']);
  });

  it('렌더를 시작한 컴포넌트마다 하위가 값 그대로 따라 렌더된 수와, 값이 실제로 바뀐 props 를 위에서 아래 순서로 모은다', () => {
    function Badge({ left }: { left: number }) {
      return <i>{left}</i>;
    }
    function Panel({ left }: { left: number }) {
      return <Badge left={left} />;
    }
    function Facts() {
      return <p>facts</p>;
    }
    function Trend() {
      return <p>trend</p>;
    }
    function Page() {
      const [left, setLeft] = useState(3);
      return (
        <div>
          <button onClick={() => setLeft((v) => v - 1)}>count</button>
          <Facts />
          <Trend />
          <Panel left={left} />
        </div>
      );
    }
    render(<Page />);
    fireEvent.click(screen.getByText('count'));
    fireEvent.click(screen.getByText('count'));
    const page = groupRenders(getTopRenders(200), 0).find((g) => g.name === 'Page')!;
    expect(page.impact).toMatchObject({ renders: 8, unchanged: 4, unchangedComponents: 2, changedProps: ['Panel.left', 'Badge.left'] });
  });

  it('render_record_throw: 한 fiber 의 기록이 던져도 나머지와 commit·구독자 알림은 이어진다', () => {
    const Ctx = createContext(0);
    Object.defineProperty(Ctx, 'displayName', {
      get: () => {
        throw new Error('boom'); // context 가 바뀐 렌더 이유를 가릴 때 읽는다
      },
    });
    const Boom = () => <i>{useContext(Ctx)}</i>;
    const Good = ({ n }: { n: number }) => <b>{n}</b>;
    let notified = 0;
    const off = subscribeCommits(() => notified++);
    render(
      <Counter>
        {(n) => (
          <Ctx.Provider value={n}>
            <Boom />
            <Good n={n} />
          </Ctx.Provider>
        )}
      </Counter>,
    );
    flushQueue();
    bump();
    flushQueue();
    off();
    expect(byName().Boom.events).toHaveLength(1); // 마운트만, 던진 갱신은 건너뜀
    expect(byName().Good.events).toHaveLength(2);
    expect(notified).toBe(2);
    expect(getCommits()).toHaveLength(2);
  });
});
