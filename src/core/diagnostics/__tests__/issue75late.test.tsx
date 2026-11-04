import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { RdxDevtools } from '../../../ui/RdxDevtools.js';
import { captureStatus } from '../../capture/install.js';
import { commitHookStatus } from '../../render/devtoolsHook.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildDiagnostics, renderEmptyReason } from '../diagnostics.js';
import { checkLoadOrder, LOAD_CHECK_DELAY_MS } from '../loadOrder.js';

// react-dom 이 rdx 보다 먼저 로드된 경우를 흉내 낸다: react-dom 이 부르는 훅의 commit 함수가 rdx 의 것이 아니다.
// (react-dom 은 로드될 때 훅을 잡아 두고 commit 마다 그 훅의 onCommitFiberRoot 를 부른다.)
beforeAll(() => {
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: { onCommitFiberRoot: () => void } };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot = () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const resource = (initiatorType: string, startTime: number, name: string) =>
  ({ initiatorType, startTime, name, entryType: 'resource' }) as unknown as PerformanceEntry;

it('react-dom 뒤에 불러왔으면 마운트 뒤 한 번 경고하고, 설치 전에 나간 요청 수와 고치는 방법을 알린다', () => {
  const installedAt = captureStatus().installedAt!;
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
    resource('fetch', installedAt - 5, 'http://localhost/api/early'),
    resource('xmlhttprequest', installedAt - 1, 'http://localhost/api/early-xhr'),
    resource('script', installedAt - 5, 'http://localhost/main.js'), // 요청이 아니다
    resource('fetch', installedAt + 10, 'http://localhost/api/late'), // 설치 뒤라 기록했다
  ]);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  render(<RdxDevtools />);
  act(() => vi.advanceTimersByTime(LOAD_CHECK_DELAY_MS));
  flushQueue();
  expect(commitHookStatus().commitsSeen).toBe(0);

  const messages = warn.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('react-data-xray'));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(/imported after react-dom/);
  expect(messages[0]).toMatch(/2 fetch\/XHR requests went out before rdx loaded/);
  expect(messages[0]).toMatch(/api\/early, http:\/\/localhost\/api\/early-xhr/);
  expect(messages[0]).toMatch(/very top of your entry file/);
  expect(messages[0]).toMatch(/instrumentation-client\.ts/);

  // 다시 판정해도(자가 점검 등) 경고는 한 번뿐이다.
  checkLoadOrder();
  expect(warn.mock.calls.filter((args) => String(args[0]).includes('react-data-xray'))).toHaveLength(1);

  // 자가 점검과 렌더 관점의 빈 상태도 같은 이유를 보인다.
  const d = buildDiagnostics();
  expect(d.renderHook.commitsSeen).toBe(0);
  expect(d.capture.requestsBeforeInstall).toBe(2);
  expect(d.problems.join(' ')).toMatch(/imported after react-dom.*went out before rdx loaded.*instrumentation-client/);
  expect(renderEmptyReason()).toMatch(/imported after react-dom/);
});

it('패널의 Status 버튼이 문제 수를 달고, 펼치면 같은 상태를 보여 준다', async () => {
  render(<RdxDevtools />);
  const button = screen.getByRole('button', { name: /Open React Data X-ray/ });
  fireEvent.pointerDown(button, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(button, { pointerId: 1 });
  const panel = screen.getByRole('complementary', { name: 'React Data X-ray' });
  fireEvent.click(within(panel).getByRole('button', { name: /^Status ⚠\d/ }));
  const status = within(panel).getByRole('status');
  expect(status.textContent).toMatch(/Render hook: no commits/);
  expect(status.textContent).toMatch(/imported after react-dom/);
  // 렌더 관점의 빈 문구가 이유를 말한다.
  fireEvent.click(within(panel).getByRole('button', { name: 'Renders' }));
  await act(async () => {
    flushQueue();
    await Promise.resolve();
  });
  expect(await within(panel).findByText(/imported after react-dom.*very top of your entry file/)).toBeTruthy();
});
