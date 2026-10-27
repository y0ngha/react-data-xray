import { touchRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { resolveStack } from './sourceMap.js';

// 이 시간 안에 나간 요청은 포커스·재연결 때문에 라이브러리가 자동으로 다시 보낸 것으로 본다.
const TRIGGER_WINDOW_MS = 1000;
const MAX_STACK_FRAMES = 15;
// React 가 StrictMode 에서 effect 를 다시 실행할 때만 호출 스택에 나오는 함수들(React 18, 19 dev 빌드).
const STRICT_MODE_REPLAY = /DoubleInvoke|invoke(Passive|Layout)EffectMountInDEV|doubleInvokeEffects/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 호출 스택에서 rdx 가로채기 코드의 프레임을 빼는 규칙.
 * - 번들 안에 있으면(Vite 사전 번들 등) rdx 번들 파일 하나만 뺀다. 같은 폴더의 다른 라이브러리(axios 등) 프레임은 남긴다.
 * - 소스·dist 그대로면 core/capture 폴더 바로 아래 파일만 뺀다(하위 폴더는 rdx 가로채기 코드가 아니다).
 * 번들러가 붙인 쿼리와, 스택에는 나오지 않는 file:// 접두사는 뺀다.
 */
export const ownFramePattern = (moduleUrl: string): RegExp => {
  const file = moduleUrl.split('?')[0].replace(/^file:\/\//, '');
  const dir = file.replace(/[^/]*$/, '');
  return dir.endsWith('/core/capture/')
    ? new RegExp(`${escapeRegExp(dir)}[^/]+:\\d+`)
    : new RegExp(`${escapeRegExp(file)}(\\?[^:]*)?:\\d+`);
};

const OWN_FRAME = ownFramePattern(import.meta.url);

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
  resolveSourceStack(record);
  return record;
};

/** dev 서버가 변환한 위치를 원본 위치로 바꿔 둔다(보고서·요청 상세가 원본 줄 번호를 보이게). 실패하면 그대로 둔다. */
const resolveSourceStack = (record: RequestRecord): void => {
  const stack = record.stack;
  if (!stack || typeof window === 'undefined') return;
  const job = resolveStack(stack)
    .then((resolved) => {
      if (resolved === stack) return;
      record.sourceStack = resolved;
      touchRecords();
    })
    .catch(() => undefined)
    .finally(() => resolving.delete(job));
  resolving.add(job);
};

const resolving = new Set<Promise<void>>();
const RESOLVE_WAIT_MS = 2000;

/** 진행 중인 소스맵 변환이 끝날 때까지(길어도 2초) 기다린다. 보고서를 저장하기 직전에 부른다. */
export const whenSourcesResolved = async (): Promise<void> => {
  if (resolving.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled(resolving), new Promise((resolve) => (timer = setTimeout(resolve, RESOLVE_WAIT_MS)))]);
  clearTimeout(timer);
};
