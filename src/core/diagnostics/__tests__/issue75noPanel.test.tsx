import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { flushQueue } from '../../scheduler/idleQueue.js';
import { LOAD_CHECK_DELAY_MS, loadOrderFindings } from '../loadOrder.js';

// 패널(<RdxDevtools>) 없이 보고서만 쓰는 설정: 진입 모듈(import 'react-data-xray')이 건 판정만으로 경고한다.
beforeAll(() => {
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: { onCommitFiberRoot: () => void } };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot = () => undefined; // react-dom 이 다른 훅에 붙은 것처럼
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('패널이 없어도 진입 모듈이 판정을 걸어, 앱이 그려졌는데 commit 이 없으면 경고한다', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  await import('../../../index.js'); // 진입 모듈이 판정을 건다
  act(() => vi.advanceTimersByTime(LOAD_CHECK_DELAY_MS));
  flushQueue();
  // 아직 앱이 그려지지 않았으면 commit 은 판정하지 않고 다시 본다.
  expect(loadOrderFindings()).toMatchObject({ appRendered: false, noCommits: false });
  expect(warn).not.toHaveBeenCalled();

  render(<div>app</div>);
  act(() => vi.advanceTimersByTime(LOAD_CHECK_DELAY_MS));
  flushQueue();
  expect(loadOrderFindings()).toMatchObject({ appRendered: true, noCommits: true });
  const messages = warn.mock.calls.map((args) => String(args[0]));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(/imported after react-dom.*very top of your entry file/);
});
