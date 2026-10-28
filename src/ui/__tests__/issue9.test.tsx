import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { flush } from '../../testing/fetchMock.js';
import { RdxDevtools } from '../RdxDevtools.js';
import { FloatingButton } from '../FloatingButton.js';
import { useProblemSignal } from '../hooks/useProblemSignal.js';

const handlers = { onPointerDown: () => undefined, onPointerMove: () => undefined, onPointerUp: () => undefined, onClick: () => undefined };
const breakdown = { waste: ['GET /a', 'GET /b'], storming: ['Comp'] };
const setup = (onSelect = vi.fn<(tab: string, key: string) => void>()) => {
  render(
    <FloatingButton position={{ x: 0, y: 0 }} issues={3} alert={false} handlers={handlers} breakdown={breakdown} onSelect={onSelect} />,
  );
  return { onSelect, button: screen.getByRole('button', { name: /React Data X-ray 열기/ }) };
};

afterEach(() => vi.useRealTimers());

it('keyboard_focus: 포커스로도 내역이 열리고, 바깥으로 포커스가 나가면 닫힌다', () => {
  const { button } = setup();
  expect(screen.queryByText(/낭비 요청 2/)).toBeNull();
  fireEvent.focus(button);
  expect(screen.getByText(/낭비 요청 2/)).toBeTruthy();
  expect(screen.getByText(/렌더 폭주 1/)).toBeTruthy();
  fireEvent.blur(button, { relatedTarget: document.body });
  expect(screen.queryByText(/낭비 요청 2/)).toBeNull();
});

it('마우스를 올려도 열리고, 항목을 누르면 해당 탭으로 가며 닫힌다', () => {
  const { button, onSelect } = setup();
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: 'GET /b' }));
  expect(onSelect).toHaveBeenCalledWith('requests', 'GET /b');
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: '<Comp>' }));
  expect(onSelect).toHaveBeenLastCalledWith('renders', 'Comp');
});

it('storm_window_note: 렌더 폭주가 최근 10초 기준이라고 적는다', () => {
  const { button } = setup();
  fireEvent.mouseEnter(button);
  expect(screen.getByText(/최근 10초 기준/)).toBeTruthy();
});

it('문제가 없으면 내역을 열지 않는다', () => {
  render(
    <FloatingButton
      position={{ x: 0, y: 0 }}
      issues={0}
      alert={false}
      handlers={handlers}
      breakdown={{ waste: [], storming: [] }}
      onSelect={vi.fn<(tab: string, key: string) => void>()}
    />,
  );
  fireEvent.mouseEnter(screen.getByRole('button'));
  expect(screen.queryByText(/최근 10초/)).toBeNull();
});

it('useProblemSignal 이 낭비 엔드포인트 이름을 개수와 함께 돌려준다', () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useProblemSignal([], () => 'ok', 2, ['GET /a', 'GET /b']));
  expect(result.current.wasteEndpoints).toEqual(['GET /a', 'GET /b']);
  expect(result.current.stormingNames).toEqual([]);
  act(() => void vi.advanceTimersByTime(1000));
});

it('RdxDevtools: 배지에 올리면 내역이 뜨고, 항목을 누르면 그 탭이 열린다', async () => {
  await fetch('/api/a');
  await fetch('/api/a');
  render(<RdxDevtools />);
  await act(flush);
  const button = screen.getByRole('button', { name: /React Data X-ray 열기/ });
  await waitFor(() => expect(button.textContent).toBe('RDX1'));
  fireEvent.mouseEnter(button);
  fireEvent.click(screen.getByRole('button', { name: 'GET /api/a' }));
  expect(screen.getByRole('complementary', { name: 'React Data X-ray' })).toBeTruthy();
  expect(screen.getByText('엔드포인트별')).toBeTruthy();
});
