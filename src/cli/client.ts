import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { COMMAND_PATH, REPORT_HEADER, SERVER_FILE, type CommandOp } from '../shared/reportPath.js';

/** CLI·MCP 가 함께 쓰는 설정 */
export interface CliOptions {
  /** dev 서버 주소. 없으면 RDX_URL, 그다음 `.rdx/.server.json`(dev 서버가 브라우저 출처를 적어 둔다) */
  url?: string;
  /** 명령을 맡길 탭 id. 없으면 dev 서버가 고른다(가장 최근에 보고서가 바뀐 탭) */
  tab?: string;
  /** 보고서 폴더(cwd 기준). 기본 .rdx */
  dir: string;
  cwd: string;
  /** 탭이 명령을 마치기를 기다리는 시간 */
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** 테스트에서 바꾼다 */
  pollMs?: number;
}

/** 종료 코드. 에이전트가 문구를 읽지 않아도 갈래를 알 수 있게 나눈다 */
export const EXIT = { ok: 0, failed: 1, usage: 2, server: 3, noTab: 4, timeout: 5 } as const;

/** 사용자에게 보여 줄 문구와 종료 코드를 가진 실패 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export interface TabInfo {
  id: string;
  path: string;
  title: string;
  seenAt: number;
  activeAt: number;
}

export interface CommandState {
  id: string;
  op: CommandOp;
  name?: string;
  tab: string;
  status: 'pending' | 'sent' | 'done' | 'failed' | 'expired';
  error?: string;
}

const readJsonFile = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

/** dev 서버 주소. --url, RDX_URL, dev 서버가 적어 둔 `.rdx/.server.json` 순으로 찾는다 */
export const resolveUrl = async (opts: CliOptions): Promise<string> => {
  const given = opts.url ?? opts.env?.RDX_URL;
  if (given) return given;
  const saved = await readJsonFile(join(opts.cwd, opts.dir, SERVER_FILE)).catch(() => null);
  const url = (saved as { url?: unknown } | null)?.url;
  if (typeof url === 'string') return url;
  throw new CliError(
    `Could not find the dev server address. Pass --url (e.g. --url http://localhost:5173), or open the app once so the dev server writes ${opts.dir}/${SERVER_FILE}.`,
    EXIT.usage,
  );
};

const describeTab = (t: TabInfo): string => `${t.id} ${t.path}${t.title ? ` "${t.title}"` : ''}`;

export const formatTabs = (tabs: readonly TabInfo[]): string =>
  tabs.length ? tabs.map((t) => `  ${describeTab(t)}`).join('\n') : '  (none)';

const NO_TAB_HINT =
  'Open the app in a browser (the page must render <RdxDevtools /> with the rdx dev server plugin attached) and try again within a few seconds. A tab hidden for a long time may answer only once a minute.';

/**
 * dev 서버에 묻는다. Origin 은 보내지 않고 Host 는 주소에서 채운다(보고서 경로와 같은 Host 검사를 거친다).
 * rdx 처리기가 붙이는 헤더가 없으면 다른 것이 답한 것이다(플러그인 없음, 이전 버전, Next 의 명령 route 없음).
 */
const call = async (base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(new URL(path, base), init).catch((error: unknown) => {
    throw new CliError(
      `Could not reach the dev server at ${base} (${error instanceof Error ? error.message : String(error)}). Is it running? Pass --url if it moved.`,
      EXIT.server,
    );
  });
  const mark = res.headers.get(REPORT_HEADER);
  if (mark === 'forbidden-host')
    throw new CliError(
      `The dev server at ${base} refused this host. Use a localhost or IP address URL, or add the host to allowedHosts.`,
      EXIT.server,
    );
  if (mark !== '1')
    throw new CliError(
      `${base} has no rdx command path (${res.status}). Attach the rdx dev server plugin (react-data-xray/vite, react-data-xray/middleware) and update react-data-xray. Next.js: add app/%5F_rdx/command/[[...id]]/route.ts with export { GET, POST } from 'react-data-xray/next'.`,
      EXIT.server,
    );
  // 실패(4xx)에도 처리기는 이유를 JSON 으로 준다. 본문이 없는 답(204)만 빈 객체다.
  if (res.status === 204 || !res.headers.get('content-type')?.startsWith('application/json')) return { status: res.status, body: {} };
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

export const listTabs = async (opts: CliOptions): Promise<TabInfo[]> => {
  const { body } = await call(await resolveUrl(opts), COMMAND_PATH);
  return Array.isArray(body.tabs) ? (body.tabs as TabInfo[]) : [];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CommandOutcome {
  command: CommandState;
  /** 다른 연결된 탭(tab 을 주지 않았을 때 dev 서버가 고르지 않은 탭) */
  others: TabInfo[];
}

/** 탭에 명령을 맡기고 끝날 때까지 기다린다 */
export const runCommand = async (opts: CliOptions, op: CommandOp, name?: string): Promise<CommandOutcome> => {
  const base = await resolveUrl(opts);
  const created = await call(base, COMMAND_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...(name !== undefined && { name }), ...(opts.tab !== undefined && { tab: opts.tab }) }),
  });
  if (created.status !== 202) {
    const error = String(created.body.error ?? `status ${created.status}`);
    const tabs = Array.isArray(created.body.tabs) ? (created.body.tabs as TabInfo[]) : undefined;
    if (created.status === 409) throw new CliError(`No browser tab is connected to ${base}. ${NO_TAB_HINT}`, EXIT.noTab);
    if (created.status === 404) throw new CliError(`${error}. Connected tabs:\n${formatTabs(tabs ?? [])}`, EXIT.noTab);
    throw new CliError(error, created.status === 400 ? EXIT.usage : EXIT.failed);
  }
  const others = (created.body.others as TabInfo[] | undefined) ?? [];
  const deadline = Date.now() + opts.timeoutMs;
  // 탭은 5초 주기로 받아 가므로 결과를 짧은 간격으로 묻는다. 한 번에 하나씩 차례로 묻는다.
  const wait = async (current: CommandState): Promise<CommandState> => {
    if (current.status !== 'pending' && current.status !== 'sent') return current;
    if (Date.now() > deadline)
      throw new CliError(
        `Tab ${current.tab} did not ${current.status === 'pending' ? 'pick up' : 'finish'} the ${op} command within ${opts.timeoutMs / 1000}s. ${NO_TAB_HINT}`,
        EXIT.timeout,
      );
    await sleep(opts.pollMs ?? 250);
    const { status, body } = await call(base, `${COMMAND_PATH}/${current.id}`);
    if (status !== 200) throw new CliError(String(body.error ?? `status ${status}`), EXIT.timeout);
    return wait(body as unknown as CommandState);
  };
  const command = await wait(created.body.command as CommandState);
  if (command.status === 'expired') throw new CliError(`Tab ${command.tab}: ${command.error ?? 'expired'}. ${NO_TAB_HINT}`, EXIT.timeout);
  if (command.status === 'failed') throw new CliError(`Tab ${command.tab} could not ${op}: ${command.error ?? 'failed'}`, EXIT.failed);
  return { command, others };
};

/** `.rdx/<name>.json`(또는 .json 으로 끝나는 경로)을 읽는다 */
export const readReportFile = async (opts: CliOptions, name: string): Promise<{ file: string; value: unknown }> => {
  const file = name.endsWith('.json') ? join(opts.cwd, name) : join(opts.cwd, opts.dir, `${name}.json`);
  try {
    return { file, value: await readJsonFile(file) };
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT';
    throw new CliError(
      missing ? `No report at ${file}. Save one with rdx snapshot ${name}.` : `Could not read ${file}: ${String(error)}`,
      EXIT.failed,
    );
  }
};

export { describeTab };
