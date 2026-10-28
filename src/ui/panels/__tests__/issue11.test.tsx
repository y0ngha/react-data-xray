import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { IGNORE_KEY } from '../../../shared/ignoredEndpoints.js';
import { installReportApi } from '../../../core/report/reportApi.js';
import { ResetButton } from '../ResetButton.js';

afterEach(() => {
  delete window.__RDX__;
  vi.useRealTimers();
});

it('버튼 하나로 reset() 을 부르고 초기화 시각을 보인다', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 14, 2, 11));
  installReportApi();
  const reset = vi.spyOn(window.__RDX__!, 'reset'); // 시각은 실제 reset 이 sessionStorage 에 남긴다
  render(<ResetButton />);
  expect(screen.queryByText(/이후 기록/)).toBeNull();
  fireEvent.click(screen.getByText('기록 지우기'));
  expect(reset).toHaveBeenCalledTimes(1);
  expect(screen.getByText('14:02:11 이후 기록')).toBeTruthy();
});

it('reset 은 무시 지정 설정을 건드리지 않는다', () => {
  localStorage.setItem(IGNORE_KEY, '["GET /a"]');
  installReportApi();
  render(<ResetButton />);
  fireEvent.click(screen.getByText('기록 지우기'));
  expect(localStorage.getItem(IGNORE_KEY)).toBe('["GET /a"]');
});
