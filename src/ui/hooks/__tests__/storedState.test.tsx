import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDraggable } from '../useDraggable.js';
import { useIgnoredEndpoints } from '../useIgnoredEndpoints.js';

afterEach(() => vi.restoreAllMocks());

describe('저장되는 state', () => {
  it('렌더를 기다리지 않고 연달아 바꿔도 앞의 변경을 잃지 않는다', () => {
    const { result } = renderHook(() => useIgnoredEndpoints());
    act(() => {
      result.current.toggle('GET /a');
      result.current.toggle('GET /b');
    });
    expect([...result.current.ignored]).toEqual(['GET /a', 'GET /b']);
    expect(JSON.parse(localStorage.getItem('react-data-xray:ignored-endpoints')!)).toEqual(['GET /a', 'GET /b']);
  });

  it('끄는 동안에는 저장하지 않고, 다 끌었을 때 한 번만 저장한다', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const Draggable = () => {
      const { position, handlers } = useDraggable(40, () => undefined);
      return <button type="button" aria-label="drag" {...handlers} data-x={position.x} />;
    };
    render(<Draggable />);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button, { clientX: 500, clientY: 500, pointerId: 1 });
    Array.from({ length: 20 }, (_, i) => fireEvent.pointerMove(button, { clientX: 500 - i * 10, clientY: 500, pointerId: 1 }));
    expect(setItem).not.toHaveBeenCalled();
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});
