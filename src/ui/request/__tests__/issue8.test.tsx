// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { isLibraryFrame } from '../../../core/capture/libraryFrame.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { StackSection } = await import('../StackSection.js');

const STACK = [
  'at load (http://localhost:5173/src/api.ts:3:4)',
  'at commitHookEffectListMount (http://localhost:5173/node_modules/.vite/deps/react-dom.js:1:2)',
  'at f (webpack-internal:///./node_modules/axios/lib/a.js:1:2)',
].join('\n');

describe('isLibraryFrame', () => {
  it('Vite 사전 번들과 webpack node_modules 는 라이브러리, 앱 경로는 아니다', () => {
    expect(isLibraryFrame('at f (http://localhost:5173/node_modules/.vite/deps/ky.js:1:2)')).toBe(true);
    expect(isLibraryFrame('at f (webpack-internal:///./node_modules/axios/lib/a.js:1:2)')).toBe(true);
    expect(isLibraryFrame('at load (http://localhost:5173/src/api.ts:3:4)')).toBe(false);
  });
});

describe('StackSection', () => {
  it('copy_full_stack: 접어 두고 누르면 펼치며, 복사는 전체 스택', async () => {
    const writeText = vi.fn<(text: string) => void>();
    Object.assign(navigator, { clipboard: { writeText } });
    const host = document.createElement('div');
    document.body.append(host);
    await act(async () => createRoot(host).render(<StackSection stack={STACK} />));
    expect(host.textContent).toContain('api.ts');
    expect(host.textContent).not.toContain('axios');
    expect(host.textContent).toContain('라이브러리 프레임 2개');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(host.textContent).toContain('axios');
    const copy = [...host.querySelectorAll('button')].find((b) => /복사/.test(b.textContent ?? ''));
    await act(async () => copy!.click());
    expect(writeText).toHaveBeenCalledWith(STACK);
  });
});
