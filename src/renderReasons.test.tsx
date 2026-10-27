// 렌더 훅은 react-dom 보다 먼저 설치돼야 하므로 가장 먼저 import 한다.
import { getTopRenders, setRenderMonitoring } from './renderMonitor.js';

import { act, cleanup, render } from '@testing-library/react';
import { createContext, memo, useContext, useDeferredValue, useEffect, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { install } from './capture.js';
import { clearRecords } from './registry.js';

const byName = () => Object.fromEntries(getTopRenders(200).map((e) => [e.name, e]));

beforeAll(() => {
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 101, name: 'cpu' }] }), { status: 200 }));
  install();
});
beforeEach(() => {
  clearRecords();
  setRenderMonitoring(true);
});
afterEach(() => {
  cleanup();
  setRenderMonitoring(false);
});

describe('렌더 판정 (감사에서 찾은 문제의 회귀 테스트)', () => {
  it('형제가 번갈아 업데이트돼도 렌더를 빠짐없이 센다', () => {
    const setters: Array<() => void> = [];
    const Sib = ({ i }: { i: number }) => {
      const [n, setN] = useState(0);
      setters[i] = () => setN((v) => v + 1);
      return <span>{n}</span>;
    };
    const SibA = () => <Sib i={0} />;
    const SibB = () => <Sib i={1} />;
    render(
      <div>
        <SibA />
        <SibB />
      </div>,
    );
    for (let k = 0; k < 10; k++) {
      act(() => setters[0]());
      act(() => setters[1]());
    }
    // Sib 두 개가 각각 mount 1 + 업데이트 10. 감사 전에는 한쪽이 1회만 집계됐다.
    const sibs = getTopRenders(200).filter((e) => e.name === 'Sib');
    expect(sibs.map((e) => e.recent)).toEqual([11, 11]);
  });

  it('context 값이 바뀐 렌더는 부모가 아니라 context 로 분류하고, 줄일 수 있는 렌더로 세지 않는다', () => {
    const Theme = createContext('light');
    Theme.displayName = 'Theme';
    let toggle = () => undefined as void;
    const Consumer = memo(function Consumer() {
      return <span>{useContext(Theme)}</span>;
    });
    function App() {
      const [theme, setTheme] = useState('light');
      toggle = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));
      return (
        <Theme.Provider value={theme}>
          <Consumer />
        </Theme.Provider>
      );
    }
    render(<App />);
    act(() => toggle());

    expect(byName().Consumer.reasons).toMatchObject({ mount: 1, context: 1, parent: 0 });
    expect(byName().Consumer.contextKeys).toEqual(['Theme']);
    expect(byName().Consumer.avoidable).toBe(0);
  });

  it('렌더마다 새로 만든 콜백(나머지 props 는 같음)은 새 콜백으로 분류한다', () => {
    let bump = () => undefined as void;
    const Button = ({ onClick, style }: { onClick: () => void; style: object }) => <button style={style} onClick={onClick} />;
    function Parent() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return (
        <div data-n={n}>
          <Button onClick={() => undefined} style={{ color: 'red' }} />
        </div>
      );
    }
    render(<Parent />);
    act(() => bump());

    expect(byName().Button.reasons).toMatchObject({ 'new-callback': 1 });
    expect(byName().Button.callbackKeys).toEqual(['onClick', 'style']);
  });

  it('Map·Set 처럼 JSON 으로 비교할 수 없는 props 는 같은 내용으로 보지 않는다', () => {
    let next = () => undefined as void;
    const View = ({ tags }: { tags: Set<string> }) => <span>{tags.size}</span>;
    function Parent() {
      const [tags, setTags] = useState(new Set(['a']));
      next = () => setTags(new Set(['a', 'b']));
      return <View tags={tags} />;
    }
    render(<Parent />);
    act(() => next());

    expect(byName().View.reasons).toMatchObject({ props: 1, 'same-content': 0 });
  });

  it('children 과 같은 내용 style 이 함께 바뀌면 children 을 빼고 같은 내용으로 판정한다', () => {
    let bump = () => undefined as void;
    const Box = ({ style, children }: { style: object; children: React.ReactNode }) => <div style={style}>{children}</div>;
    function Parent() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return (
        <Box style={{ margin: 1 }}>
          <i>{n}</i>
        </Box>
      );
    }
    render(<Parent />);
    act(() => bump());

    expect(byName().Box.reasons).toMatchObject({ 'same-content': 1 });
    expect(byName().Box.sameContentKeys).toEqual(['style']);
  });

  it('useDeferredValue 의 지연 렌더는 부모 렌더가 아니라 state 로 분류한다', async () => {
    let type = (_v: string) => undefined as void;
    function Search() {
      const [q, setQ] = useState('');
      const deferred = useDeferredValue(q);
      type = setQ;
      return <span>{deferred}</span>;
    }
    render(<Search />);
    await act(async () => type('abc'));

    expect(byName().Search.reasons.parent).toBe(0);
  });
});

describe('렌더의 네트워크 원인', () => {
  it('응답을 state 로 받은 렌더는 직접, 그 데이터를 props 로 받은 자식은 부모를 따라 네트워크 원인이다', async () => {
    const Row = ({ item }: { item: { name: string } }) => <li>{item.name}</li>;
    function List() {
      const [items, setItems] = useState<Array<{ id: number; name: string }>>([]);
      useEffect(() => {
        fetch('/api/items')
          .then((r) => r.json())
          .then((json) => setItems(json.items));
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const list = byName().List;
    const row = byName().Row;
    expect(list.network).toBe(1);
    expect(list.causes[0]).toMatchObject({ direct: 1, parent: 0 });
    expect(list.causes[0].record.url).toBe('/api/items');
    // Row 는 응답 객체를 props 로 받으며 mount 됐다(직접 근거).
    expect(row.network).toBe(1);
  });

  it('네트워크와 무관한 state 변경 렌더는 원인을 붙이지 않는다', () => {
    let bump = () => undefined as void;
    function Counter() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return <span>{n}</span>;
    }
    render(<Counter />);
    act(() => bump());

    expect(byName().Counter.network).toBe(0);
    expect(byName().Counter.recent).toBe(2);
  });
});
