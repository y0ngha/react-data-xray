import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { RequestClass } from '../../core/requests/classify.js';
import { createRecord, finishRecord, getRecords } from '../../core/requests/store.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { FloatingButton } from '../FloatingButton.js';
import { useProblemSignal } from '../hooks/useProblemSignal.js';

// 낭비가 있는 엔드포인트 두 개(배지 수 2)
const TWO_WASTEFUL = [
  { endpoint: 'GET /a', duplicates: 1, sameResponses: 0 },
  { endpoint: 'GET /b', duplicates: 0, sameResponses: 1 },
];
const handlers = { onPointerDown: () => undefined, onPointerMove: () => undefined, onPointerUp: () => undefined, onClick: () => undefined };
const ok = (_r: RequestRecord): RequestClass => 'ok';
// performance(timeOrigin) 는 진짜로 두고 타이머와 시계만 바꾼다(첫 로딩 판정이 timeOrigin 을 본다).
const fakeAt = (now: number) => vi.useFakeTimers({ now, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });

afterEach(() => vi.useRealTimers());

it('문제가 있으면 개수를 달고 이름에도 넣으며, 없으면 달지 않는다', () => {
  const { rerender } = render(<FloatingButton position={{ x: 0, y: 0 }} issues={3} alert={false} handlers={handlers} />);
  const button = screen.getByRole('button', { name: 'Open React Data X-ray (3 issues)' });
  expect(button.textContent).toBe('RDX3');
  rerender(<FloatingButton position={{ x: 0, y: 0 }} issues={0} alert={false} handlers={handlers} />);
  expect(screen.getByRole('button', { name: 'Open React Data X-ray' }).textContent).toBe('RDX');
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
  const { result, rerender } = renderHook(({ classOf }) => useProblemSignal(getRecords(), classOf, TWO_WASTEFUL), {
    initialProps: { classOf: ok },
  });
  expect(result.current).toMatchObject({ issues: 2, alert: false });
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
  const { result } = renderHook(() => useProblemSignal(getRecords(), ok));
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.alert).toBe(false);
});

// #82: 데이터 라우터는 새 화면의 요청을 받은 뒤에 주소를 바꾼다. 몰림이 끝나고, 버튼이 한 번 돌고, 그 뒤에 이동한다.
// 앞 테스트의 이동 기록과 겹치지 않게 테스트마다 다른 시각에서 시작한다.
const alertsAroundLoader = (navigate: boolean, start: number): boolean[] => {
  fakeAt(performance.timeOrigin + start);
  const { result } = renderHook(() => useProblemSignal(getRecords(), ok));
  const alerts: boolean[] = [];
  const tick = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };
  tick(100);
  burst(navigate ? 'loader' : 'waste'); // 몰림이 끝나 기록에 들어온다.
  tick(900); // 버튼이 돈다. 아직 이동 전이다.
  alerts.push(result.current.alert);
  tick(50);
  if (navigate) window.history.pushState(null, '', '/orders');
  for (let i = 0; i < 3; i++) {
    tick(i === 0 ? 950 : 1000);
    alerts.push(result.current.alert);
  }
  window.history.replaceState(null, '', '/');
  return alerts;
};

it('주소를 바꾸기 전에 받은 새 화면의 몰림에는 깜빡이지 않는다 (#82)', () => {
  expect(alertsAroundLoader(true, 60_000)).toEqual([false, false, false, false]);
});

it('이동이 따르지 않은 몰림은 끝나고 1초 뒤에 한 번 알린다', () => {
  expect(alertsAroundLoader(false, 120_000)).toEqual([false, true, false, false]);
});

it('응답이 1.4초 걸린 loader 몰림 뒤에 주소를 바꾸면 깜빡이지 않는다 (#82)', () => {
  fakeAt(performance.timeOrigin + 180_000);
  const { result } = renderHook(() => useProblemSignal(getRecords(), ok));
  const alerts: boolean[] = [];
  vi.advanceTimersByTime(100);
  const loader = Array.from({ length: 5 }, (_, i) => createRecord('fetch', 'GET', `/api/slow/${i}`));
  act(() => {
    vi.advanceTimersByTime(1400); // 버튼이 한 번 돈다. 응답 전이라 기록에 없다.
  });
  alerts.push(result.current.alert);
  loader.forEach((r) => finishRecord(r, 200));
  act(() => {
    vi.advanceTimersByTime(50);
  });
  window.history.pushState(null, '', '/slow');
  for (let i = 0; i < 4; i++) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    alerts.push(result.current.alert);
  }
  window.history.replaceState(null, '', '/');
  expect(alerts).toEqual([false, false, false, false, false]);
});

/** 100ms 마다 요청을 보내 바로 받는 끝나지 않는 반복을 ms 동안 돌리고, 버튼이 돌 때마다 알림을 모은다. */
const alertsDuringLoop = (start: number, ms: number, navigate: boolean): boolean[] => {
  fakeAt(performance.timeOrigin + start);
  if (navigate) window.history.pushState(null, '', '/feed');
  const { result } = renderHook(() => useProblemSignal(getRecords(), ok));
  const alerts: boolean[] = [];
  for (let t = 100; t <= ms; t += 100) {
    finishRecord(createRecord('fetch', 'GET', '/api/loop'), 200);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    if (t % 1000 === 0) alerts.push(result.current.alert);
  }
  window.history.replaceState(null, '', '/');
  return alerts;
};

it('끝나지 않는 반복은 2초 안에 한 번 알린다 (#82)', () => {
  const alerts = alertsDuringLoop(240_000, 6000, false);
  expect(alerts.indexOf(true)).toBe(1);
  expect(alerts.filter(Boolean)).toHaveLength(1);
});

it('화면에 들어오며 시작한 끝나지 않는 반복은 진입 창이 지나면 알린다 (#82)', () => {
  const alerts = alertsDuringLoop(300_000, 8000, true);
  // 이동 3초 뒤까지 시작한 창은 진입이다.
  expect(alerts.slice(0, 3)).toEqual([false, false, false]);
  expect(alerts.filter(Boolean)).toHaveLength(1);
});
