import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getFiber } from '../../fiber/tree.js';
import type { Fiber } from '../../fiber/types.js';
import { stateHookLabel } from '../summary.js';

const useDraft = () => {
  const [changes, setChanges] = useState({});
  return { changes, setChanges };
};
const useEditor = () => {
  const [open] = useState(false);
  return { open, ...useDraft() };
};
import { useState } from 'react';

const Editor = () => {
  const { changes } = useEditor();
  const [plain] = useState(0);
  return <div>{`${JSON.stringify(changes)}${plain}`}</div>;
};

let root: ReturnType<typeof createRoot> | undefined;
const mount = async (): Promise<Fiber> => {
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root!.render(<Editor />));
  return getFiber(el.firstElementChild!)!.return!;
};
afterEach(async () => {
  await act(async () => root?.unmount());
});

describe('커스텀 훅 경로 (#21)', () => {
  it('nested_custom_hooks: 두 겹 안 useState 는 두 훅 이름', async () => {
    const fiber = await mount();
    expect(stateHookLabel(fiber, 2)).toBe('useEditor › useDraft › useState #2');
    expect(stateHookLabel(fiber, 1)).toBe('useEditor › useState #1');
    expect(stateHookLabel(fiber, 3)).toBe('useState #3');
  });
  it('no_debug_info: _debugHookTypes 없으면 지금 label', async () => {
    const fiber = await mount();
    expect(stateHookLabel({ ...fiber, _debugHookTypes: null }, 2)).toBe('훅 칸 #2');
  });
  it('컴포넌트가 던져도 label 은 순번 형태로 남는다', () => {
    const fiber = {
      tag: 0,
      type: () => {
        throw new Error('x');
      },
      memoizedProps: {},
      _debugHookTypes: ['useState'],
    } as unknown as Fiber;
    expect(stateHookLabel(fiber, 1)).toBe('useState #1');
  });
});
