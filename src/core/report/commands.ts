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

let focusedAt = 0;
let tracking = false;

/** 탭을 고르지 않은 CLI 명령을 받을 탭을 dev 서버가 고를 수 있게, 마지막으로 포커스를 받은 때를 기억한다 */
const touch = (): void => {
  if (document.visibilityState === 'visible') focusedAt = Date.now();
};

const trackFocus = (): void => {
  if (tracking) return;
  tracking = true;
  if (document.hasFocus()) touch();
  window.addEventListener('focus', touch);
  document.addEventListener('visibilitychange', touch);
};

/** 받아 가기·업로드 주소에 붙이는 탭 정보(보이는지, 포커스를 받은 지 얼마나 됐는지) */
export const tabState = (): Record<string, string> => {
  trackFocus();
  return {
    visible: document.visibilityState === 'visible' ? '1' : '0',
    ...(focusedAt > 0 && { focusedAgo: String(Date.now() - focusedAt) }),
  };
};

let cliActive = false;
let lastPoll = 0;

/**
 * 보고서가 그대로인 주기에 받아 가기(GET)를 보낼지. CLI·MCP 가 최근에 명령 경로를 썼으면(dev 서버가 응답에 표시한다) 5초마다,
 * 아니면 QUIET_POLL_MS 마다 보낸다. 명령이 없을 때 dev 서버로 5초마다 요청이 나가지 않게 한다.
 */
export const shouldPoll = (now: number): boolean => cliActive || now - lastPoll >= QUIET_POLL_MS;

/** 받아 가기·업로드 응답을 받았다. CLI 가 쓰는 중인지 기억한다 */
export const notePolled = (res: Response, now: number): void => {
  cliActive = res.headers.get(CLI_ACTIVE_HEADER) === '1';
  lastPoll = now;
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
      const result = await run(command, runner);
      const query = new URLSearchParams({ command: command.id, tab });
      await send(`${REPORT_PATH}?${query}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json', [TAB_HEADER]: '1' },
        body: JSON.stringify(result),
      }).catch(() => null);
    });
  });
  await chain;
};
