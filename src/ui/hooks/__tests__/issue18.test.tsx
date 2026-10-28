import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DOCK } from '../useDockSettings.js';
import { useCollapseForAppModal } from '../useAppModalOpen.js';

const openModal = () => {
  const el = document.createElement('div');
  el.setAttribute('aria-modal', 'true');
  el.getClientRects = () => [new DOMRect()] as unknown as DOMRectList;
  el.getBoundingClientRect = () => new DOMRect(300, 20, 400, 300);
  document.body.append(el);
  return el;
};

const flushFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe('앱 모달을 피하는 패널', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('도킹을 고르지 않았으면 겹치지 않는 도킹으로 옮기고 접지 않는다', async () => {
    openModal();
    const { result } = renderHook(() => useCollapseForAppModal(true, DEFAULT_DOCK));
    await flushFrame();
    expect(result.current.settings.dock).toBe('bottom');
    expect(result.current.collapsed).toBe(false);
  });

  it('user_position_respected: 사용자가 고른 도킹은 그대로 두고 접는다', async () => {
    openModal();
    const chosen = { ...DEFAULT_DOCK, chosen: true };
    const { result } = renderHook(() => useCollapseForAppModal(true, chosen));
    await flushFrame();
    expect(result.current.settings.dock).toBe('float');
    expect(result.current.collapsed).toBe(true);
  });
});

describe('자동 dock 에서 크기 조절 (#18)', () => {
  it('크기만 저장되고 dock 과 chosen 은 바뀌지 않는다', async () => {
    const { useDockSettings } = await import('../useDockSettings.js');
    const { result } = renderHook(() => useDockSettings());
    act(() => result.current.update({ bottomHeight: 400 }));
    expect(result.current.settings).toMatchObject({ dock: 'float', bottomHeight: 400 });
    expect(result.current.settings.chosen).toBeUndefined();
  });
});
