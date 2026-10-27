import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { createRecord, finishRecord, getRecords } from '../../core/requests/store.js';
import { FloatingButton } from '../FloatingButton.js';
import { useProblemSignal } from '../hooks/useProblemSignal.js';

const handlers = { onPointerDown: () => undefined, onPointerMove: () => undefined, onPointerUp: () => undefined, onClick: () => undefined };

afterEach(() => vi.useRealTimers());

it('문제가 있으면 개수를 달고 제목에 적으며, 없으면 달지 않는다', () => {
  const { rerender } = render(<FloatingButton position={{ x: 0, y: 0 }} issues={3} alert={false} handlers={handlers} />);
  const button = screen.getByRole('button', { name: 'React Data X-ray 열기' });
  expect(button.textContent).toBe('RDX3');
  expect(button.title).toContain('문제 3개');
  rerender(<FloatingButton position={{ x: 0, y: 0 }} issues={0} alert={false} handlers={handlers} />);
  expect(button.textContent).toBe('RDX');
});

it('방금 요청이 몰리면 알리고, 낭비 엔드포인트 수를 문제 수에 넣는다', () => {
  vi.useFakeTimers();
  Array.from({ length: 5 }, (_, i) => {
    const r = createRecord('fetch', 'GET', `/api/burst/${i}`);
    finishRecord(r, 200);
    return r;
  });
  const { result } = renderHook(() => useProblemSignal(getRecords(), 2));
  expect(result.current).toEqual({ issues: 2, alert: false });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.alert).toBe(true);
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(result.current.alert).toBe(false);
});
