import { act, fireEvent, render, screen } from '@testing-library/react';
import { createContext, memo, useContext, useDeferredValue, useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BODY, flush } from '../../../testing/fetchMock.js';
import {
  getCommits,
  getRenderInfo,
  getTopRenders,
  ignoreComponent,
  reportWindowMs,
  resetRenderStats,
  setRenderMonitoring,
  subscribeCommits,
} from '../monitor.js';

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

  it('부모를 따라 렌더된 자손은 렌더를 시작한 조상(이름·이유)과 자기를 그리는 JSX 위치를 남긴다', () => {
    function Leaf() {
      return <em>leaf</em>;
    }
    function Middle() {
      return <Leaf />;
    }
    render(<Counter>{() => <Middle />}</Counter>);
    bump(2);
    const leaf = getTopRenders(200).find((e) => e.name === 'Leaf')!;
    expect(leaf.origins).toEqual([{ name: 'Counter', reason: 'state', count: 2 }]);
    expect(leaf.location).toMatch(/monitor\.test\.tsx:\d+$/);
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
