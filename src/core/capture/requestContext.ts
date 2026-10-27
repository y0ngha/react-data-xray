import type { RequestRecord } from '../requests/types.js';

// 이 시간 안에 나간 요청은 포커스·재연결 때문에 라이브러리가 자동으로 다시 보낸 것으로 본다.
const TRIGGER_WINDOW_MS = 1000;
const MAX_STACK_FRAMES = 15;
// React 가 StrictMode 에서 effect 를 다시 실행할 때만 호출 스택에 나오는 함수들(React 18, 19 dev 빌드).
const STRICT_MODE_REPLAY = /DoubleInvoke|invoke(Passive|Layout)EffectMountInDEV|doubleInvokeEffects/;
// 호출 스택에서 rdx 가로채기 코드의 프레임을 빼기 위한 이 폴더의 경로.
// 번들러가 붙인 쿼리와, 스택에는 나오지 않는 file:// 접두사를 뺀다.
const OWN_DIR = import.meta.url
  .split('?')[0]
  .replace(/^file:\/\//, '')
  .replace(/[^/]*$/, '');
// 이 폴더 바로 아래 파일의 프레임만 뺀다(하위 폴더는 rdx 가로채기 코드가 아니다).
const OWN_FRAME = new RegExp(`${OWN_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^/]+:\\d+`);

const lastAt = { focus: 0, reconnect: 0 };

/**
 * React Query 의 refetchOnWindowFocus, SWR 의 revalidateOnFocus 처럼 라이브러리가
 * 포커스·재연결 때 다시 요청하는 시점을 기억한다.
 */
export const trackRefetchTriggers = (): void => {
  window.addEventListener('focus', () => {
    lastAt.focus = Date.now();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lastAt.focus = Date.now();
  });
  window.addEventListener('online', () => {
    lastAt.reconnect = Date.now();
  });
};

const triggerAt = (time: number): RequestRecord['trigger'] => {
  if (time - lastAt.reconnect <= TRIGGER_WINDOW_MS) return 'reconnect';
  if (time - lastAt.focus <= TRIGGER_WINDOW_MS) return 'focus';
  return undefined;
};

/** 앱 코드의 호출 위치. rdx 가로채기 프레임은 뺀다. */
const appStack = (raw: string): string | undefined =>
  raw
    .split('\n')
    .slice(1)
    .filter((line) => !OWN_FRAME.test(line))
    .map((line) => line.trim())
    .slice(0, MAX_STACK_FRAMES)
    .join('\n') || undefined;

/** 새 요청에 보낸 위치, StrictMode 재실행 여부, 자동 재요청 여부를 붙인다. */
export const annotateRequest = (record: RequestRecord): RequestRecord => {
  const raw = new Error().stack ?? '';
  // 판정은 자르기 전 전체 스택으로 한다. React 내부 프레임은 앱 코드보다 한참 아래에 있다.
  record.strictModeReplay = STRICT_MODE_REPLAY.test(raw) || undefined;
  record.stack = appStack(raw);
  record.trigger = triggerAt(record.startedAt);
  return record;
};
