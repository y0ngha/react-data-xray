import { describe, expect, it } from 'vitest';
import { libraryPackageOf } from '../../fiber/tree.js';
import type { Fiber } from '../../fiber/types.js';
import { groupRenders } from '../groups.js';
import { summarize } from '../summary.js';
import type { RenderEntry } from '../types.js';

const entry = (name: string, extra: Partial<RenderEntry> = {}): RenderEntry => ({
  name,
  events: [{ time: 900, reason: 'parent' }],
  fiber: null,
  memoized: false,
  ...extra,
});
const withSummary = (e: RenderEntry) => ({ ...e, ...summarize(e, 1000), ...e });

describe('위치별 렌더 그룹 (#25)', () => {
  it('같은 Row 를 두 위치에서 그리고 한쪽만 렌더를 시작하면 영향은 그쪽 그룹에만 붙는다', () => {
    const rowA = entry('Row', { location: 'src/A.tsx:10', events: [{ time: 900, reason: 'state' }] });
    const rowB = entry('Row', { location: 'src/B.tsx:20', events: [{ time: 900, reason: 'mount' }] });
    const child = entry('Cell', {
      location: 'src/Cell.tsx:1',
      events: [{ time: 900, reason: 'parent', origin: { name: 'Row', reason: 'state', from: rowA } }],
    });
    const groups = groupRenders([rowA, rowB, child].map(withSummary), 0);
    expect(groups.find((g) => g.location === 'src/A.tsx:10')?.impact).toMatchObject({ renders: 1, unchanged: 1 });
    expect(groups.find((g) => g.location === 'src/B.tsx:20')?.impact).toBeUndefined();
  });

  it('same_name_two_sites: 같은 Row 를 두 위치에서 그리면 그룹 둘', () => {
    const groups = groupRenders(
      [
        entry('Row', { location: 'src/A.tsx:10' }),
        entry('Row', { location: 'src/B.tsx:20' }),
        entry('Row', { location: 'src/A.tsx:10' }),
      ].map(withSummary),
    );
    expect(groups.map((g) => [g.location, g.instances]).sort()).toEqual([
      ['src/A.tsx:10', 2],
      ['src/B.tsx:20', 1],
    ]);
  });

  it('library_folded: 라이브러리 컴포넌트는 그린 앱 컴포넌트 아래로 접히고 패키지가 붙는다', () => {
    const owner = { name: 'Page', location: 'src/Page.tsx:5' };
    const groups = groupRenders(
      [
        entry('Page', { location: 'src/Page.tsx:5' }),
        entry('Ie', { package: '@mui/material', owner }),
        entry('Ie', { package: '@mui/material', owner }),
      ].map(withSummary),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].libraries).toEqual([{ package: '@mui/material', name: 'Ie', instances: 2, renders: 2, avoidable: 2 }]);
  });

  it('그린 앱 컴포넌트가 목록에 없으면 라이브러리 그룹이 package 와 함께 남는다', () => {
    const groups = groupRenders([withSummary(entry('Ie', { package: 'ky', owner: { name: 'Gone' } }))]);
    expect(groups).toMatchObject([{ name: 'Ie', package: 'ky' }]);
  });
});

const stackFiber = (frame: string): Fiber =>
  ({
    _debugStack: {
      stack: `Error: react-stack-top-frame\n    at jsxDEV (http://l/node_modules/.vite/deps/react_jsx-dev-runtime.js:1:2)\n    ${frame}`,
    },
  }) as unknown as Fiber;

describe('libraryPackageOf', () => {
  it('node_modules·사전 번들 경로에서 패키지 이름을 읽는다', () => {
    expect(libraryPackageOf(stackFiber('at Ie (http://l/node_modules/.pnpm/x/node_modules/@mui/material/Button.js:3:4)'))).toBe(
      '@mui/material',
    );
    expect(libraryPackageOf(stackFiber('at Ie (http://l/node_modules/.vite/deps/@mui_material.js?v=1:3:4)'))).toBe('@mui/material');
  });
  it('앱 코드가 만들었으면 undefined', () => {
    expect(libraryPackageOf(stackFiber('at Page (http://l/src/Page.tsx:3:4)'))).toBeUndefined();
    expect(libraryPackageOf({ _debugSource: { fileName: '/p/src/A.tsx', lineNumber: 3 } } as unknown as Fiber)).toBeUndefined();
    expect(libraryPackageOf({} as Fiber)).toBeUndefined();
  });
});
