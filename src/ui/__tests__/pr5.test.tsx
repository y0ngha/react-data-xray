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
  it('그 탭이 뜬 뒤에도 한 번 받고, 다른 탭 것은 받지 않으며, 같은 항목을 다시 골라도 다시 받는다', () => {
    focusItem('requests', 'GET /a'); // 탭이 아직 없을 때
    const seen: Array<string | undefined> = [];
    const { result } = renderHook(() => {
      const key = useFocusedItem('requests');
      seen.push(key);
      return key;
    });
    expect(seen).toContain('GET /a');
    expect(result.current).toBeUndefined();
    seen.length = 0;
    act(() => focusItem('renders', 'Comp'));
    expect(seen.filter(Boolean)).toEqual([]);
    act(() => focusItem('requests', 'GET /a'));
    expect(seen.filter(Boolean)).toEqual(['GET /a']);
  });
});
