// 렌더 훅은 react-dom 보다 먼저 설치돼야 하므로 가장 먼저 import 한다.
import { getRenderInfo, getTopRenders, setRenderMonitoring } from './renderMonitor.js';

import { act, render } from '@testing-library/react';
import { memo, useState } from 'react';
import { describe, expect, it } from 'vitest';

describe('renderMonitor', () => {
  it('실제로 렌더된 컴포넌트만 세고, bailout 한 자식은 세지 않는다', () => {
    let bump = () => undefined as void;
    const Child = memo(function Child() {
      return <span>child</span>;
    });
    function Parent() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return (
        <div>
          {n}
          <Child />
        </div>
      );
    }
    setRenderMonitoring(true);
    render(<Parent />);
    act(() => bump());
    act(() => bump());

    const counts = Object.fromEntries(getTopRenders(50).map((e) => [e.name, e.recent]));
    // 처음 mount 1번 + 상태 변경 2번
    expect(counts.Parent).toBe(3);
    // memo 로 props 가 같으니 mount 1번뿐이다.
    expect(counts.Child).toBe(1);

    const parent = getTopRenders(50).find((e) => e.name === 'Parent')!;
    expect(getRenderInfo(parent.fiber)).toMatchObject({ recent: 3 });
    setRenderMonitoring(false);
  });

  it('렌더 이유를 state, props, 같은 내용 새 참조, 부모로 나눈다', () => {
    let bump = () => undefined as void;
    let changeLabel = () => undefined as void;
    function Static() {
      return <i>static</i>;
    }
    function Rows({ items, label }: { items: number[]; label: string }) {
      return (
        <b>
          {label}
          {items.length}
        </b>
      );
    }
    function Page() {
      const [n, setN] = useState(0);
      const [label, setLabel] = useState('a');
      bump = () => setN((v) => v + 1);
      changeLabel = () => setLabel('b');
      // 렌더마다 내용은 같은 새 배열을 내려 준다.
      const items = [1, 2, 3];
      return (
        <div data-n={n}>
          <Static />
          <Rows items={items} label={label} />
        </div>
      );
    }
    setRenderMonitoring(true);
    render(<Page />);
    act(() => bump());
    act(() => changeLabel());

    const byName = Object.fromEntries(getTopRenders(50).map((e) => [e.name, e]));
    expect(byName.Page.reasons).toMatchObject({ mount: 1, state: 2 });
    // props 가 없는 자식은 부모 때문에만 렌더된다 → React.memo 후보
    expect(byName.Static.reasons).toMatchObject({ mount: 1, parent: 2 });
    // items 는 내용이 같은 새 배열, label 은 실제로 바뀜
    expect(byName.Rows.reasons).toMatchObject({ mount: 1, 'same-content': 1, props: 1 });
    expect(byName.Rows.sameContentKeys).toEqual(['items']);
    expect(byName.Rows.avoidable).toBe(1);
    setRenderMonitoring(false);
  });
});
