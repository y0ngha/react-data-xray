import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { RequestClass } from '../../core/requests/classify.js';
import { createRecord, finishRecord, getRecords } from '../../core/requests/store.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { FloatingButton } from '../FloatingButton.js';
import { useProblemSignal } from '../hooks/useProblemSignal.js';

const handlers = { onPointerDown: () => undefined, onPointerMove: () => undefined, onPointerUp: () => undefined, onClick: () => undefined };
const ok = (_r: RequestRecord): RequestClass => 'ok';
// performance(timeOrigin) 는 진짜로 두고 타이머와 시계만 바꾼다(첫 로딩 판정이 timeOrigin 을 본다).
const fakeAt = (now: number) => vi.useFakeTimers({ now, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });

afterEach(() => vi.useRealTimers());

it('문제가 있으면 개수를 달고 이름에도 넣으며, 없으면 달지 않는다', () => {
  const { rerender } = render(<FloatingButton position={{ x: 0, y: 0 }} issues={3} alert={false} handlers={handlers} />);
  const button = screen.getByRole('button', { name: 'React Data X-ray 열기 (문제 3개)' });
  expect(button.textContent).toBe('RDX3');
  rerender(<FloatingButton position={{ x: 0, y: 0 }} issues={0} alert={false} handlers={handlers} />);
  expect(screen.getByRole('button', { name: 'React Data X-ray 열기' }).textContent).toBe('RDX');
});

const burst = (prefix: string): RequestRecord[] =>
  Array.from({ length: 5 }, (_, i) => {
    const r = createRecord('fetch', 'GET', `/api/${prefix}/${i}`);
    finishRecord(r, 200);
    return r;
  });

it('새 요청 몰림에 한 번만 알리고, 무시한 반복과 페이지 첫 로딩 몰림에는 알리지 않는다', () => {
  // 페이지 첫 로딩(3초 안)이 지난 시각으로 시작한다.
  fakeAt(performance.timeOrigin + 10_000);
  burst('a');
  const { result, rerender } = renderHook(({ classOf }) => useProblemSignal(getRecords(), classOf, 2), { initialProps: { classOf: ok } });
  expect(result.current).toEqual({ issues: 2, alert: false });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.alert).toBe(true);
  // 같은 몰림이 아직 2초 창 안에 있어도 다시 알리지 않는다.
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.alert).toBe(false);
  // 무시한 엔드포인트의 몰림은 알리지 않는다.
  burst('b');
  rerender({ classOf: (r: RequestRecord) => (r.url.startsWith('/api/b') ? 'ignored' : 'ok') });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.alert).toBe(false);
});

it('페이지 첫 로딩 3초 안의 몰림에는 알리지 않는다', () => {
  fakeAt(performance.timeOrigin + 500);
  burst('c');
  const { result } = renderHook(() => useProblemSignal(getRecords(), ok, 0));
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.alert).toBe(false);
});
