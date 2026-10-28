import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppModalRect } from '../useAppModalOpen.js';
import { useDockSettings } from '../useDockSettings.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('useDockSettings parse (PR5-4, ponytail PR5-2)', () => {
  it('chosen 없이 저장된 float 이 아닌 도킹은 고른 것으로 본다', () => {
    localStorage.setItem('react-data-xray:dock', JSON.stringify({ dock: 'right', bottomHeight: 320, rightWidth: 520 }));
    expect(renderHook(() => useDockSettings()).result.current.settings.chosen).toBe(true);
  });
  it('chosen 없이 저장된 float 은 고르지 않은 것이고, 저장된 chosen 은 따른다', () => {
    localStorage.setItem('react-data-xray:dock', JSON.stringify({ dock: 'float' }));
    expect(renderHook(() => useDockSettings()).result.current.settings.chosen).toBe(false);
    localStorage.setItem('react-data-xray:dock', JSON.stringify({ dock: 'float', chosen: true }));
    expect(renderHook(() => useDockSettings()).result.current.settings.chosen).toBe(true);
  });
});

describe('useAppModalRect: 변이 없이 크기가 바뀌어도 다시 잰다 (PR5-8)', () => {
  const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  it('창 크기 변경과 모달의 전환 끝에 재측정한다', async () => {
    const el = document.createElement('div');
    el.setAttribute('aria-modal', 'true');
    el.getClientRects = () => [new DOMRect()] as unknown as DOMRectList;
    let height = 100;
    el.getBoundingClientRect = () => new DOMRect(0, 0, 400, height);
    document.body.append(el);
    const { result } = renderHook(() => useAppModalRect(true));
    await frame();
    expect(result.current?.height).toBe(100);
    height = 300; // 열림 애니메이션이 끝난 크기
    act(() => void el.dispatchEvent(new Event('transitionend', { bubbles: true })));
    await frame();
    expect(result.current?.height).toBe(300);
    height = 500;
    act(() => void window.dispatchEvent(new Event('resize')));
    await frame();
    expect(result.current?.height).toBe(500);
  });
});
