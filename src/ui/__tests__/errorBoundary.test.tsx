import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { RdxErrorBoundary } from '../RdxErrorBoundary.js';

it('rdx 안에서 난 렌더 오류는 rdx 만 숨기고 앱은 그대로 두며, 새로고침 때 같은 화면이 다시 열리지 않게 기억한 상태를 지운다', () => {
  sessionStorage.setItem('react-data-xray:open', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // jsdom 은 잡힌 렌더 오류도 window error 로 한 번 더 알린다. 테스트 출력에 스택이 쏟아지지 않게 막는다.
  const quiet = (e: ErrorEvent) => e.preventDefault();
  window.addEventListener('error', quiet);
  const Broken = () => {
    throw new Error('boom');
  };
  render(
    <main>
      <p>앱</p>
      <RdxErrorBoundary>
        <Broken />
      </RdxErrorBoundary>
    </main>,
  );
  expect(screen.getByText('앱')).toBeTruthy();
  expect(warn).toHaveBeenCalled();
  expect(sessionStorage.getItem('react-data-xray:open')).toBeNull();
  window.removeEventListener('error', quiet);
  vi.restoreAllMocks();
});
