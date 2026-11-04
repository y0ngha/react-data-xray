import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { RdxDevtools } from '../../../ui/RdxDevtools.js';
import { commitHookStatus } from '../../render/devtoolsHook.js';
import { isRenderMonitoring } from '../../render/monitor.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildDiagnostics } from '../diagnostics.js';
import { LOAD_CHECK_DELAY_MS, loadOrderFindings } from '../loadOrder.js';

// 올바른 순서: 테스트 설정(src/testing/setup.ts)이 렌더 감시를 react-dom 보다 먼저 불러온다.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('렌더 감시가 꺼져 있어도 훅이 받은 commit 을 센다', () => {
  expect(isRenderMonitoring()).toBe(false);
  const before = commitHookStatus().commitsSeen;
  render(<div>app</div>);
  expect(commitHookStatus().commitsSeen).toBeGreaterThan(before);
});

it('react-dom 보다 먼저 불러왔으면 마운트 뒤 판정에서 경고하지 않는다', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  render(<RdxDevtools />);
  expect(loadOrderFindings()).toBeNull(); // 마운트 직후가 아니라 잠시 뒤 유휴 큐에서 판정한다
  act(() => vi.advanceTimersByTime(LOAD_CHECK_DELAY_MS));
  flushQueue();
  expect(loadOrderFindings()).toEqual({ noCommits: false, early: { count: 0, urls: [] }, appRendered: true });
  expect(warn.mock.calls.flat().join('\n')).not.toMatch(/react-data-xray/);
  const d = buildDiagnostics();
  expect(d.renderHook.commitsSeen).toBeGreaterThan(0);
  expect(d.problems).toEqual([]);
});
