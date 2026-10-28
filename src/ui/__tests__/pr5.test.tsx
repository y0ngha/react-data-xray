import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FloatingButton } from '../FloatingButton.js';
import { focusItem, useFocusedItem } from '../viewState.js';

const handlers = { onPointerDown: () => undefined, onPointerMove: () => undefined, onPointerUp: () => undefined, onClick: () => undefined };
const setup = () => {
  const onSelect = vi.fn<(tab: string, key: string) => void>();
  render(
    <FloatingButton
      position={{ x: 0, y: 0 }}
      issues={1}
      alert={false}
      handlers={handlers}
      breakdown={{ waste: ['GET /a'], storming: ['Comp'] }}
      onSelect={onSelect}
    />,
  );
  return { onSelect, rdx: screen.getByRole('button', { name: /React Data X-ray 열기/ }) };
};

describe('FloatingButton 내역 (ponytail PR5-6, PR5-11)', () => {
  it('열리면 aria-describedby 로 내역을 가리키고, 항목을 고르면 포커스가 RDX 버튼에 남고 내역은 닫힌 채다', () => {
    const { rdx, onSelect } = setup();
    expect(rdx.getAttribute('aria-describedby')).toBeNull();
    fireEvent.focus(rdx);
    const popup = document.getElementById(rdx.getAttribute('aria-describedby')!);
    expect(popup?.textContent).toContain('GET /a');
    const item = screen.getByRole('button', { name: 'GET /a' });
    item.focus();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('requests', 'GET /a');
    expect(document.activeElement).toBe(rdx);
    expect(screen.queryByText('GET /a')).toBeNull();
  });

  it('항목 mousedown 은 기본 동작(포커스 이동)을 막는다', () => {
    const { rdx } = setup();
    fireEvent.mouseEnter(rdx);
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: '<Comp>' }))).toBe(false);
  });
});

describe('focusItem / useFocusedItem (ponytail PR5-7, #9)', () => {
  it('그 탭이 뜬 뒤에도 받고, 다른 탭 것은 받지 않으며, 같은 항목을 다시 골라도 새 요청으로 받고, 탭이 닫히면 비운다', () => {
    focusItem('requests', 'GET /a'); // 탭이 아직 없을 때
    const first = renderHook(() => useFocusedItem('requests'));
    expect(first.result.current?.key).toBe('GET /a');
    const before = first.result.current;
    act(() => focusItem('renders', 'Comp'));
    expect(first.result.current).toBeUndefined(); // 요청은 하나뿐이라 다른 탭 것으로 바뀐다
    act(() => focusItem('requests', 'GET /a'));
    expect(first.result.current?.key).toBe('GET /a');
    expect(first.result.current).not.toBe(before);
    first.unmount();
    expect(renderHook(() => useFocusedItem('requests')).result.current).toBeUndefined();
  });
});
