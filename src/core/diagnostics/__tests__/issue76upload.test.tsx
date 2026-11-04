import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { REPORT_HEADER, REPORT_PATH } from '../../../shared/reportPath.js';
import { mockFetch } from '../../../testing/fetchMock.js';
import { RdxDevtools } from '../../../ui/RdxDevtools.js';
import { commitHookStatus } from '../../render/devtoolsHook.js';
import { ignoreComponent } from '../../render/monitor.js';
import { installReportApi } from '../../report/reportApi.js';

// 진입 모듈(index.ts)처럼 패널 자신의 렌더는 렌더 감시에서 뺀다.
ignoreComponent(RdxDevtools);

const uploads = () =>
  mockFetch.mock.calls.filter(([input, init]) => String(input).startsWith(`${REPORT_PATH}?tab=`) && init?.method === 'POST').length;

it('패널 자신의 commit 으로 받은 commit 수만 늘면, 멈춘 앱의 보고서를 다시 보내지 않는다', async () => {
  vi.useFakeTimers();
  try {
    mockFetch.mockImplementation(async () => new Response(null, { status: 204, headers: { [REPORT_HEADER]: '1' } }));
    installReportApi();
    render(<RdxDevtools />);
    await vi.advanceTimersByTimeAsync(0);
    const button = screen.getByRole('button', { name: /Open React Data X-ray/ });
    fireEvent.pointerDown(button, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(button, { pointerId: 1 });
    const panel = screen.getByRole('complementary', { name: 'React Data X-ray' });
    // 첫 보고서 뒤로 내용이 가라앉을 때까지 한 주기 보낸다.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    const before = uploads();
    const commits = commitHookStatus().commitsSeen;
    // 패널만 다시 그린다(앱은 그대로).
    fireEvent.click(within(panel).getByRole('button', { name: /^Status/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /^Status/ }));
    expect(commitHookStatus().commitsSeen).toBeGreaterThan(commits);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(uploads()).toBe(before);
  } finally {
    vi.useRealTimers();
  }
});
