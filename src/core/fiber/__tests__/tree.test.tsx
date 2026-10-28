import { fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, memo, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../../../testing/fetchMock.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { collectValues } from '../componentValues.js';
import {
  componentRect,
  findRootFibers,
  getComponentName,
  getFiber,
  hostNodesOf,
  isFrameworkDevtoolsRoot,
  isMemoized,
  jsxLocationOf,
  resolveJsxLocation,
  toCurrent,
  unionRect,
} from '../tree.js';
import type { Fiber } from '../types.js';

const Plain = () => <span>plain</span>;
const Named = Object.assign(() => <span>named</span>, { displayName: 'Custom' });
const Forwarded = forwardRef<HTMLSpanElement>(function Fwd(_props, ref) {
  return <span ref={ref}>fwd</span>;
});
const Memo = memo(function Inner() {
  return <span>memo</span>;
});

describe('fiber tree', () => {
  it('요소에서 가장 가까운 컴포넌트 fiber 와 이름을 찾는다', () => {
    render(
      <div>
        <Plain />
        <Named />
        <Forwarded />
        <Memo />
      </div>,
    );
    const nameOf = (text: string) => {
      let f = getFiber(screen.getByText(text));
      while (f && typeof f.type === 'string') f = f.return;
      return f ? getComponentName(f) : null;
    };
    expect(nameOf('plain')).toBe('Plain');
    expect(nameOf('named')).toBe('Custom');
    expect(nameOf('fwd')).toBe('Fwd');
    expect(nameOf('memo')).toBe('Inner');
    expect(getComponentName({ type: null })).toBe('Anonymous');
    expect(getFiber(document.createElement('div'))).toBeNull();
  });

  it('여러 번 렌더된 뒤에도 지금 화면의 fiber(current)를 돌려준다', () => {
    function Counter() {
      const [n, setN] = useState(0);
      return <button onClick={() => setN((v) => v + 1)}>{`count ${n}`}</button>;
    }
    render(<Counter />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    const fiber = getFiber(screen.getByRole('button'))!;
    expect((fiber.memoizedProps as { children: string }).children).toBe('count 2');
    // HostRoot 에 닿지 않는 조각난 fiber 는 그대로 돌려준다.
    const orphan = { tag: 0, return: null } as Fiber;
    expect(toCurrent(orphan)).toBe(orphan);
  });

  it('memo 로 감싼 컴포넌트를 알아본다', () => {
    render(<Memo />);
    let f = getFiber(screen.getByText('memo'));
    while (f && typeof f.type === 'string') f = f.return;
    expect(isMemoized(f!)).toBe(true);
  });

  it('루트를 찾고, 컴포넌트가 그린 DOM 과 그 영역을 계산한다', () => {
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 30, 40));
    function Pair() {
      return (
        <>
          <i>a</i>
          <b>b</b>
        </>
      );
    }
    render(<Pair />);
    const roots = findRootFibers();
    expect(roots.length).toBeGreaterThan(0);
    const pair = roots[0].child!;
    expect(hostNodesOf(pair).map((n) => n.tagName)).toEqual(['I', 'B']);
    expect(componentRect(pair, () => false)).toEqual(new DOMRect(10, 20, 30, 40));
    expect(componentRect(pair, () => true)).toBeNull();
    spy.mockRestore();
    expect(unionRect([])).toBeNull();
  });

  it('unmount 된 루트는 건너뛴다', () => {
    const view = render(<Plain />);
    expect(findRootFibers().length).toBeGreaterThan(0);
    view.unmount();
    expect(() => findRootFibers()).not.toThrow();
  });

  it('문서 자체를 컨테이너로 쓰는 루트(Next.js App Router 의 hydrateRoot(document))도 찾는다', () => {
    const view = render(<Plain />);
    // render 가 만든 루트를 문서에 붙은 것처럼 옮긴다.
    const key = Object.keys(view.container).find((k) => k.startsWith('__reactContainer$'))!;
    const docKeys = document as unknown as Record<string, unknown>;
    const hostRoot = (view.container as unknown as Record<string, unknown>)[key];
    delete (view.container as unknown as Record<string, unknown>)[key];
    docKeys[key] = hostRoot;
    try {
      const plain = findRootFibers().find((root) => root.child && getComponentName(root.child) === 'Plain');
      expect(plain).toBeDefined();
    } finally {
      delete docKeys[key];
      (view.container as unknown as Record<string, unknown>)[key] = hostRoot;
      view.unmount();
    }
  });

  it('Next.js dev overlay(<nextjs-portal> 자체나 그 shadow DOM 안)의 루트는 프레임워크 도구로 본다', () => {
    const host = document.createElement('nextjs-portal');
    expect(isFrameworkDevtoolsRoot(host)).toBe(true);
    document.body.appendChild(host);
    const inside = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(inside);
    expect(isFrameworkDevtoolsRoot(inside)).toBe(true);
    expect(isFrameworkDevtoolsRoot(document.body)).toBe(false);
    expect(isFrameworkDevtoolsRoot(document)).toBe(false);
    expect(isFrameworkDevtoolsRoot(null)).toBe(false);
    host.remove();
  });

  it('컴포넌트가 들고 있는 props, 훅 state, 클래스 state 를 모은다', () => {
    function WithHooks({ label }: { label: string }) {
      const [value] = useState({ v: 1 });
      return <span>{`${label}${value.v}`}</span>;
    }
    render(<WithHooks label="x" />);
    let f = getFiber(screen.getByText('x1'));
    while (f && typeof f.type === 'string') f = f.return;
    expect(collectValues(f!)).toEqual([
      { via: 'props', value: { label: 'x' } },
      { via: 'hook[0]', value: { v: 1 } },
    ]);
    const classFiber = { tag: 1, memoizedProps: { a: 1 }, memoizedState: { s: 2 } } as Fiber;
    expect(collectValues(classFiber)).toEqual([
      { via: 'props', value: { a: 1 } },
      { via: 'state', value: { s: 2 } },
    ]);
  });
});

describe('React 19 의 JSX 위치(_debugStack)', () => {
  const fiberWithStack = (lines: string[]) => ({ _debugStack: { stack: ['Error: react-stack-top-frame', ...lines].join('\n') } }) as never;

  it('React·라이브러리 프레임을 건너뛰고 JSX 를 쓴 앱 프레임을 src/... 부터로 줄인다(번들러 쿼리는 뗀다)', () => {
    const fiber = fiberWithStack([
      'at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:15)',
      'at Middle (http://localhost:5173/src/components/Middle.tsx?t=1712:12:7)',
      'at App (http://localhost:5173/src/App.tsx:5:3)',
    ]);
    expect(jsxLocationOf(fiber)).toBe('src/components/Middle.tsx:12');
  });

  it('Firefox·Safari 형식(fn@url:줄:열)도 읽는다', () => {
    const fiber = fiberWithStack([
      'jsxDEV@http://localhost:5173/node_modules/.vite/deps/react.js:1:1',
      'Middle@http://localhost:5173/src/Middle.tsx:8:4',
    ]);
    expect(jsxLocationOf(fiber)).toBe('src/Middle.tsx:8');
  });

  it('_debugSource(React 18)가 있으면 그것을 쓰고, 둘 다 없으면 undefined', () => {
    expect(jsxLocationOf({ _debugSource: { fileName: '/Users/me/project/src/A.tsx', lineNumber: 3 } } as never)).toBe('src/A.tsx:3');
    expect(jsxLocationOf({} as never)).toBeUndefined();
  });

  it('dev 서버가 변환한 줄을 소스맵으로 원본 줄로 바꾼다', async () => {
    const inlineMap = (map: object) => `data:application/json;base64,${btoa(JSON.stringify(map))}`;
    // 변환된 3번째 줄 → 원본 10번째 줄(MAPPINGS 는 sourceMap 테스트와 같은 모양)
    const code = `a\nb\nrender()\n//# sourceMappingURL=${inlineMap({ version: 3, sources: ['Middle.tsx'], mappings: ';;AASE' })}`;
    mockFetch.mockImplementation(async () => new Response(code));
    const fiber = fiberWithStack(['at Middle (http://localhost:3000/src/Middle.tsx:3:1)']);
    const resolved = resolveJsxLocation(fiber);
    flushQueue(); // 소스맵 해석은 유휴 큐에서 한다
    await Promise.resolve();
    flushQueue();
    expect(await resolved).toBe('src/Middle.tsx:10');
  });
});
