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
});
