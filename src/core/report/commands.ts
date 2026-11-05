import {
  CLI_ACTIVE_HEADER,
  isCommandOp,
  isReportName,
  isTabId,
  QUIET_POLL_MS,
  REPORT_PATH,
  TAB_HEADER,
  type RdxCommand,
  type RdxCommandResult,
} from '../../shared/reportPath.js';

/** 명령을 실행할 함수. window.__RDX__ 의 것을 그대로 받는다 */
export interface CommandRunner {
  reset: () => void;
  snapshot: (name: string) => Promise<unknown>;
}

const isCommand = (c: unknown): c is RdxCommand => {
  if (typeof c !== 'object' || c === null) return false;
  const { id, op, name } = c as Partial<RdxCommand>;
  return (
    typeof id === 'string' && isTabId(id) && isCommandOp(op) && (op !== 'snapshot' || (typeof name === 'string' && isReportName(name)))
  );
};

const run = async (command: RdxCommand, runner: CommandRunner): Promise<RdxCommandResult> => {
  try {
    if (command.op === 'reset') runner.reset();
    else await runner.snapshot(command.name!);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// 마지막으로 포커스를 잃은 시각. 포커스가 있는 동안은 쓰지 않는다(그동안은 "방금"이다).
let blurredAt = 0;
let tracking = false;

const onBlur = (): void => {
  blurredAt = Date.now();
};

/**
 * 탭을 고르지 않은 CLI 명령을 받을 탭을 dev 서버가 고를 수 있게, 포커스를 잃은 지 얼마나 됐는지 알린다.
 * 지금 포커스가 있으면 0 이다. 가려졌다 다시 보이는 것(visibilitychange)은 포커스로 치지 않는다(다른 창 뒤에서 드러났을 뿐일 수 있다).
 */
const trackFocus = (): void => {
  if (tracking) return;
  tracking = true;
  window.addEventListener('blur', onBlur);
};

/** 받아 가기·업로드 주소에 붙이는 탭 정보(보이는지, 포커스를 잃은 지 얼마나 됐는지). 포커스를 받은 적이 없으면 focusedAgo 를 뺀다 */
export const tabState = (): Record<string, string> => {
  trackFocus();
  const focusedAgo = document.hasFocus() ? 0 : blurredAt > 0 ? Date.now() - blurredAt : undefined;
  return {
    visible: document.visibilityState === 'visible' ? '1' : '0',
    ...(focusedAgo !== undefined && { focusedAgo: String(focusedAgo) }),
  };
};

let cliActive = false;
let lastPoll = Number.NEGATIVE_INFINITY;

/**
 * 보고서가 그대로인 주기에 받아 가기(GET)를 보낼지. CLI·MCP 가 최근에 명령 경로를 썼으면(dev 서버가 응답에 표시한다) 5초마다,
 * 아니면 QUIET_POLL_MS 마다 보낸다. 명령이 없을 때 dev 서버로 5초마다 요청이 나가지 않게 한다.
 * QUIET_POLL_MS 를 1분보다 짧게 두어, 브라우저가 타이머를 1분에 한 번만 깨우는 가려진 탭도 깰 때마다 받아 간다.
 */
export const shouldPoll = (now: number): boolean => cliActive || now - lastPoll >= QUIET_POLL_MS;

/** 받아 가기를 보낸다. 응답을 받은 때가 아니라 보낸 때를 기준으로 다음 주기를 센다 */
export const notePollSent = (now: number): void => {
  lastPoll = now;
};

/** 받아 가기·업로드 응답을 받았다. CLI 가 쓰는 중인지 기억한다 */
export const notePolled = (res: Response): void => {
  cliActive = res.headers.get(CLI_ACTIVE_HEADER) === '1';
};

const RESULT_TRIES = 3;
const RESULT_RETRY_MS = 500;

/** 결과를 알린다. 응답이 없거나 5xx 면(dev 서버가 잠깐 바쁜 등) 간격을 늘려 가며 몇 번 더 보낸다 */
const report = async (send: typeof fetch, url: string, result: RdxCommandResult, attempt = 1): Promise<void> => {
  const res = await send(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', [TAB_HEADER]: '1' },
    body: JSON.stringify(result),
  }).catch(() => null);
  if ((res && res.status < 500) || attempt >= RESULT_TRIES) return;
  await new Promise((resolve) => window.setTimeout(resolve, RESULT_RETRY_MS * 2 ** (attempt - 1)));
  return report(send, url, result, attempt + 1);
};

/** 실행 직전에 명령이 아직 살아 있는지 묻는다. 앞 명령을 기다리는 사이 CLI 가 포기했으면(시간 초과·취소) 실행하지 않는다 */
const isLive = async (send: typeof fetch, url: string): Promise<boolean> => {
  const res = await send(url, { method: 'GET', credentials: 'omit', headers: { [TAB_HEADER]: '1' } }).catch(() => null);
  return res?.status === 204;
};

// 한 번에 하나씩 실행한다. reset 뒤의 snapshot 처럼 보낸 순서가 의미 있다.
let chain: Promise<unknown> = Promise.resolve();

/**
 * dev 서버가 업로드·받아 가기 응답으로 넘긴 명령(CLI·MCP 가 맡긴 reset·snapshot, #69)을 실행하고 결과를 알린다.
 * 명령이 없으면 서버는 본문 없이(204) 답하므로 대부분의 주기에는 아무것도 읽지 않는다.
 * 응답은 가로채기 전의 fetch 로 받은 것이라 res.json() 이 요청 기록에 섞이지 않는다.
 */
export const receiveCommands = async (send: typeof fetch, res: Response, tab: string, runner: CommandRunner): Promise<void> => {
  if (res.status !== 200 || !res.headers.get('content-type')?.startsWith('application/json')) return;
  const payload = (await res.json().catch(() => null)) as { commands?: unknown } | null;
  const commands = Array.isArray(payload?.commands) ? payload.commands.filter(isCommand) : [];
  commands.forEach((command) => {
    chain = chain.then(async () => {
      const url = `${REPORT_PATH}?${new URLSearchParams({ command: command.id, tab })}`;
      if (!(await isLive(send, url))) return;
      await report(send, url, await run(command, runner));
    });
  });
  await chain;
};
