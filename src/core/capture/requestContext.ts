import { touchRecords } from '../requests/store.js';
import { enqueue, flushQueue, isQueuePending } from '../scheduler/idleQueue.js';
import type { RequestRecord } from '../requests/types.js';
import { componentOfStack, hasAppFrame } from './callerComponent.js';
import { resolveStack } from './sourceMap.js';

// 이 시간 안에 나간 요청은 포커스·재연결 때문에 라이브러리가 자동으로 다시 보낸 것으로 본다.
const TRIGGER_WINDOW_MS = 1000;
// 요청 기록에 남기는 앱 쪽 프레임 수. StrictMode 판정은 CAPTURE_FRAMES 전체로 하고, 기록은 앞부분만 둔다.
const MAX_STACK_FRAMES = 10;
// React 가 StrictMode 에서 effect 를 다시 실행할 때만 호출 스택에 나오는 함수들(React 18, 19 dev 빌드).
export const STRICT_MODE_REPLAY = /DoubleInvoke|invoke(Passive|Layout)EffectMountInDEV|doubleInvokeEffects/;
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

/**
 * 이 모듈이 실제로 실행되는 파일. 보통은 import.meta.url 이지만, Turbopack·webpack 은 import.meta.url 을 원본 경로로 두고
 * 코드는 청크(…/_next/static/chunks/node_modules_react-data-xray_dist_….js)에서 실행해 스택과 맞지 않는다.
 * 그때는 지금 스택의 첫 프레임(이 모듈) 파일을 쓴다.
 */
export const runtimeModuleUrl = (declared: string, stack: string | undefined): string => {
  const declaredPath = declared.split('?')[0].replace(/^file:\/\//, '');
  if (!stack || stack.includes(declaredPath)) return declared;
  const frame = stack
    .split('\n')
    .slice(1)
    .map((line) => /((?:https?|file):\/\/[^\s()]+?)(?::\d+){1,2}\)?\s*$/.exec(line)?.[1])
    .find((url): url is string => !!url);
  return frame ?? declared;
};

const OWN_FRAME = ownFramePattern(runtimeModuleUrl(import.meta.url, new Error().stack));

// StrictMode 재실행 프레임(React 19 의 doubleInvokeEffectsOnFiber)은 앱 코드보다 한참 아래에 있어,
// V8 기본(10프레임)이면 가로채기·effect 프레임에 밀려 잘린다. 요청을 기록할 때만 이만큼 남긴다.
const CAPTURE_FRAMES = 40;

/**
 * 지금 호출 스택을 담은 Error. 상한이 CAPTURE_FRAMES 보다 낮을 때(V8 기본 10)만 이 한 번 올리고 되돌린다.
 * 상한이 없거나(Firefox) 이미 넉넉하면(Safari 100, 앱이 올려 둔 값) 건드리지 않고, 고칠 수 없게 얼린 Error(SES)면 그대로 만든다.
 */
export const captureStack = (): Error => {
  const limit = Error.stackTraceLimit;
  if (typeof limit !== 'number' || limit >= CAPTURE_FRAMES) return new Error();
  try {
    Error.stackTraceLimit = CAPTURE_FRAMES;
  } catch {
    return new Error();
  }
  try {
    return new Error();
  } finally {
    Error.stackTraceLimit = limit;
  }
};

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

/** 새 요청에 보낸 위치(fallback: 이 요청의 Request 를 만든 시점의 스택), StrictMode 재실행 여부, 자동 재요청 여부를 붙인다. */
export const annotateRequest = (record: RequestRecord, fallback?: Error): RequestRecord => {
  record.trigger = triggerAt(record.startedAt); // 요청 시점의 포커스·재연결 상태여야 한다
  if (typeof location !== 'undefined') record.route = location.pathname; // 문자열 하나만 읽는다. 이후 SPA 이동과 섞이지 않게 지금
  const err = captureStack(); // .stack 은 V8 이 늦게 만들므로 여기서 읽지 않는다
  enqueue(() => {
    const raw = err.stack ?? '';
    // 판정은 자르기 전 전체 스택으로 한다. React 내부 프레임은 앱 코드보다 한참 아래에 있다.
    record.strictModeReplay = STRICT_MODE_REPLAY.test(raw) || undefined;
    // 스택에 앱 프레임이 없으면(ky 의 타이머 경로) 같은 Request 를 만든 시점의 스택을 대신 쓴다.
    record.stack = appStack(raw);
    if (fallback && !hasAppFrame(record.stack)) record.stack = appStack(fallback.stack ?? '') ?? record.stack;
    record.component = componentOfStack(record.stack);
    record.noAppFrame = !hasAppFrame(record.stack) || undefined;
    resolveSourceStack(record);
    return true;
  });
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

// 소스맵 step 은 맵을 받은 뒤에야 큐에 들어오므로, 큐를 비우고 한 틱 기다리기를 변환이 끝날 때까지 되풀이한다.
const settle = async (deadline: number): Promise<void> => {
  flushQueue();
  if ((resolving.size === 0 && !isQueuePending()) || Date.now() >= deadline) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settle(deadline);
};

/** 진행 중인 소스맵 변환이 끝날 때까지(길어도 2초) 기다린다. 보고서를 저장하기 직전에 부른다. */
export const whenSourcesResolved = (): Promise<void> => settle(Date.now() + RESOLVE_WAIT_MS);
