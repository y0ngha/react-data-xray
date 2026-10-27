import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDockSettings } from '../useDockSettings.js';
import { useDraggable } from '../useDraggable.js';
import { useElementPicker } from '../useElementPicker.js';
import { matchesHotkey, useHotkey } from '../useHotkey.js';
import { useIgnoredEndpoints } from '../useIgnoredEndpoints.js';
import { useNow } from '../useNow.js';
import { usePopupWindow } from '../usePopupWindow.js';

// jsdom 에는 elementFromPoint 가 없어 테스트마다 돌려줄 요소를 정한다.
const pointAt = (el: Element) => Object.defineProperty(document, 'elementFromPoint', { value: () => el, configurable: true });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('저장되는 설정', () => {
  it('무시한 엔드포인트를 켜고 끄며 다음에도 기억한다', () => {
    const { result, unmount } = renderHook(() => useIgnoredEndpoints());
    act(() => result.current.toggle('GET /a'));
    act(() => result.current.toggle('GET /b'));
    act(() => result.current.toggle('GET /a'));
    expect([...result.current.ignored]).toEqual(['GET /b']);
    unmount();
    expect([...renderHook(() => useIgnoredEndpoints()).result.current.ignored]).toEqual(['GET /b']);
  });

  it('저장된 도킹 설정이 잘못되면 기본값을 쓰고, 바꾼 설정은 기억한다', () => {
    localStorage.setItem('react-data-xray:dock', JSON.stringify({ dock: 'nowhere' }));
    const { result } = renderHook(() => useDockSettings());
    expect(result.current.settings).toEqual({ dock: 'float', bottomHeight: 320, rightWidth: 520 });
    act(() => result.current.update({ dock: 'bottom', bottomHeight: 400 }));
    expect(JSON.parse(localStorage.getItem('react-data-xray:dock')!)).toMatchObject({ dock: 'bottom', bottomHeight: 400 });
  });
});

describe('useDraggable', () => {
  const Draggable = ({ onClick }: { onClick: () => void }) => {
    const { position, handlers } = useDraggable(40, onClick);
    return <button type="button" {...handlers} data-x={position.x} data-y={position.y} />;
  };

  it('끌면 위치를 옮겨 기억하고 클릭으로 치지 않으며, 그냥 누르면 클릭이다', () => {
    const onClick = vi.fn<() => void>();
    render(<Draggable onClick={onClick} />);
    const button = screen.getByRole('button');
    const start = { x: Number(button.dataset.x), y: Number(button.dataset.y) };
    fireEvent.pointerDown(button, { clientX: start.x, clientY: start.y, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: start.x - 100, clientY: start.y - 50, pointerId: 1 });
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(onClick).not.toHaveBeenCalled();
    expect(Number(button.dataset.x)).toBe(start.x - 100);
    expect(JSON.parse(localStorage.getItem('react-data-xray:button')!)).toEqual({ x: start.x - 100, y: start.y - 50 });

    fireEvent.pointerDown(button, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: 1, clientY: 1, pointerId: 1 });
    fireEvent.pointerUp(button, { pointerId: 1 });
    // 누르지 않은 상태의 움직임은 무시한다.
    fireEvent.pointerMove(button, { clientX: 500, clientY: 500, pointerId: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('useHotkey', () => {
  it('Ctrl 또는 Cmd 와 Shift·Alt 조합을 정확히 맞춘다', () => {
    const base = { ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, key: 'D' };
    expect(matchesHotkey(base, { key: 'd', shift: true })).toBe(true);
    expect(matchesHotkey({ ...base, metaKey: false }, { key: 'd', shift: true })).toBe(false);
    expect(matchesHotkey(base, { key: 'd' })).toBe(false);
    expect(matchesHotkey({ ...base, altKey: true }, { key: 'd', shift: true })).toBe(false);
  });

  it('단축키와 Esc 를 각각 부른다', () => {
    const onHotkey = vi.fn<() => void>();
    const onEscape = vi.fn<() => void>();
    renderHook(() => useHotkey({ key: 'd', shift: true }, onHotkey, onEscape));
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'x' });
    expect(onHotkey).toHaveBeenCalledTimes(1);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe('useElementPicker', () => {
  it('켜져 있는 동안 호버한 요소를 강조하고, 클릭하면 앱 대신 선택한다', () => {
    const target = document.createElement('p');
    document.body.append(target);
    const appClick = vi.fn<() => void>();
    target.addEventListener('click', appClick);
    pointAt(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(1, 2, 3, 4));
    const onPick = vi.fn<(el: Element) => void>();
    const { result, rerender } = renderHook(({ active }) => useElementPicker(active, onPick), { initialProps: { active: true } });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }));
    });
    expect(result.current).toEqual(new DOMRect(1, 2, 3, 4));
    fireEvent.click(target);
    expect(onPick).toHaveBeenCalledWith(target);
    expect(appClick).not.toHaveBeenCalled();
    rerender({ active: false });
    expect(result.current).toBeNull();
    target.remove();
  });

  it('rdx 자신의 UI 는 고르지 않는다', () => {
    const own = document.createElement('div');
    own.setAttribute('data-rdx-root', '');
    document.body.append(own);
    pointAt(own);
    const onPick = vi.fn<(el: Element) => void>();
    renderHook(() => useElementPicker(true, onPick));
    fireEvent.click(own);
    expect(onPick).not.toHaveBeenCalled();
    own.remove();
  });
});

describe('useNow', () => {
  it('주기마다 갱신하고 멈추면 그대로 둔다', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ paused }) => useNow(500, paused), { initialProps: { paused: false } });
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBeGreaterThan(first);
    rerender({ paused: true });
    const stopped = result.current;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(stopped);
  });
});

describe('usePopupWindow', () => {
  it('창이 막히면 바로 닫힌 것으로 알린다', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const onClosed = vi.fn<() => void>();
    const { result } = renderHook(() => usePopupWindow(onClosed));
    act(() => result.current.open());
    expect(result.current.popup).toBeNull();
    expect(onClosed).toHaveBeenCalled();
  });

  it('연 창을 돌려주고, 사용자가 닫으면 알리며, close 하면 창을 닫는다', () => {
    vi.useFakeTimers();
    const makePopup = () => ({ closed: false, close: vi.fn<() => void>(), document: document.implementation.createHTMLDocument('popup') });
    const first = makePopup();
    vi.spyOn(window, 'open').mockReturnValue(first as unknown as Window);
    const onClosed = vi.fn<() => void>();
    const { result } = renderHook(() => usePopupWindow(onClosed));
    act(() => result.current.open());
    expect(result.current.popup).toBe(first);
    expect(first.document.title).toBe('React Data X-ray');
    first.closed = true;
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onClosed).toHaveBeenCalled();
    expect(result.current.popup).toBeNull();

    const second = makePopup();
    vi.spyOn(window, 'open').mockReturnValue(second as unknown as Window);
    act(() => result.current.open());
    act(() => result.current.close());
    expect(second.close).toHaveBeenCalled();
  });
});
