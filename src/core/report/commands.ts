import { COMMAND_OPS, isReportName, REPORT_PATH, type RdxCommand, type RdxCommandResult } from '../../shared/reportPath.js';

/** 명령을 실행할 함수. window.__RDX__ 의 것을 그대로 받는다 */
export interface CommandRunner {
  reset: () => void;
  snapshot: (name: string) => Promise<unknown>;
}

const isCommand = (c: unknown): c is RdxCommand => {
  if (typeof c !== 'object' || c === null) return false;
  const { id, op, name } = c as Partial<RdxCommand>;
  return (
    typeof id === 'string' &&
    /^[\w-]{1,64}$/.test(id) &&
    (COMMAND_OPS as readonly unknown[]).includes(op) &&
    (op !== 'snapshot' || (typeof name === 'string' && isReportName(name)))
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
      }).catch(() => null);
    });
  });
  await chain;
};
