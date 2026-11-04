import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { COMMAND_PATH, isReportName, REPORT_HEADER, SERVER_FILE, TOKEN_HEADER, type CommandOp } from '../shared/reportPath.js';

/** CLI·MCP 가 함께 쓰는 설정 */
export interface CliOptions {
  /** dev 서버 주소. 없으면 RDX_URL, 그다음 `.rdx/.server.json`(dev 서버가 브라우저 출처를 적어 둔다) */
  url?: string;
  /** 명령을 맡길 탭 id. 없으면 dev 서버가 고른다(보이는 탭 중 최근에 포커스를 받은 탭) */
  tab?: string;
  /** 보고서 폴더(cwd 기준). 기본 .rdx */
  dir: string;
  cwd: string;
  /** 탭이 명령을 마치기를 기다리는 시간. dev 서버도 이만큼(조금 더) 명령을 들고 있는다 */
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** 테스트에서 바꾼다 */
  pollMs?: number;
}

/** 종료 코드. 에이전트가 문구를 읽지 않아도 갈래를 알 수 있게 나눈다 */
export const EXIT = { ok: 0, failed: 1, usage: 2, server: 3, noTab: 4, timeout: 5, pickTab: 6 } as const;

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
  visible: boolean;
  focusedAt: number;
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

interface Server {
  base: string;
  token?: string;
}

/** dev 서버가 적어 둔 `.rdx/.server.json`(토큰, 브라우저 출처) */
const readServerFile = async (opts: CliOptions): Promise<{ url?: string; token?: string }> => {
  const saved = (await readJsonFile(join(opts.cwd, opts.dir, SERVER_FILE)).catch(() => null)) as Record<string, unknown> | null;
  return {
    ...(typeof saved?.url === 'string' && { url: saved.url }),
    ...(typeof saved?.token === 'string' && { token: saved.token }),
  };
};

/** dev 서버 주소와 토큰. 주소는 --url, RDX_URL, `.rdx/.server.json` 순으로 찾는다 */
const resolveServer = async (opts: CliOptions): Promise<Server> => {
  const saved = await readServerFile(opts);
  const base = opts.url ?? opts.env?.RDX_URL ?? saved.url;
  if (base) return { base, token: saved.token };
  throw new CliError(
    `Could not find the dev server address. Pass --url (e.g. --url http://localhost:5173), or open the app once so the dev server writes ${opts.dir}/${SERVER_FILE}.`,
    EXIT.usage,
  );
};

/**
 * 지울 글자: C0·C1 제어 문자(터미널 이스케이프), 보이지 않는 글자와 줄·방향 바꿈(U+200B–U+200F, U+2028–U+202E, U+2066–U+2069).
 * 정규식에 제어 문자를 쓰지 않으려고 코드 포인트로 본다.
 */
const isHidden = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** 페이지가 정한 값(제목·경로)은 믿을 수 없다. 제어 문자를 지우고 짧게 잘라, 페이지가 준 값임을 밝혀 보여 준다 */
export const untrusted = (text: unknown, max = 80): string => {
  const clean = [...String(text ?? '')].map((c) => (isHidden(c.codePointAt(0)!) ? ' ' : c)).join('');
  return JSON.stringify(clean.length > max ? `${clean.slice(0, max)}…` : clean);
};

export const describeTab = (t: TabInfo): string =>
  `${t.id}  ${t.visible ? 'visible' : 'hidden'}  page path: ${untrusted(t.path, 120)}  page title: ${untrusted(t.title)}`;

export const formatTabs = (tabs: readonly TabInfo[]): string =>
  tabs.length ? tabs.map((t) => `  ${describeTab(t)}`).join('\n') : '  (none)';

const NO_TAB_HINT =
  'Open the app in a browser (the page must render <RdxDevtools /> with the rdx dev server plugin attached) and try again. The first command can take up to a minute to reach the tab; later ones about 5s.';

const TOKEN_HINT = `The dev server rejected the token in ${SERVER_FILE}. Run this in the app folder (or pass --dir to the plugin's report folder), and make sure --url points to this app's dev server.`;

const send = async (server: Server, path: string, init: RequestInit = {}) => {
  const headers = { ...(init.headers as Record<string, string>), ...(server.token && { [TOKEN_HEADER]: server.token }) };
  return fetch(new URL(path, server.base), { ...init, headers }).catch((error: unknown) => {
    throw new CliError(
      `Could not reach the dev server at ${server.base} (${error instanceof Error ? error.message : String(error)}). Is it running? Pass --url if it moved.`,
      EXIT.server,
    );
  });
};

/**
 * 명령 경로에 묻는다. Origin 은 보내지 않고 Host 는 주소에서 채우며(보고서 경로와 같은 Host 검사), 토큰을 붙인다.
 * 토큰이 틀렸으면(dev 서버를 다시 띄웠거나 아직 파일이 없었으면) 파일을 다시 읽고 한 번 더 보낸다.
 * rdx 처리기가 붙이는 헤더가 없으면 다른 것이 답한 것이다(플러그인 없음, 이전 버전, Next 의 명령 route 없음).
 */
const call = async (opts: CliOptions, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
  const server = await resolveServer(opts);
  let res = await send(server, path, init);
  if (res.status === 403 && res.headers.get(REPORT_HEADER) === '1') {
    const { token } = await readServerFile(opts);
    if (token && token !== server.token) res = await send({ ...server, token }, path, init);
  }
  const mark = res.headers.get(REPORT_HEADER);
  if (mark === 'forbidden-host')
    throw new CliError(
      `The dev server at ${server.base} refused this host. Use a localhost or IP address URL, or add the host to allowedHosts.`,
      EXIT.server,
    );
  if (mark !== '1')
    throw new CliError(
      `${server.base} has no rdx command path (${res.status}). Attach the rdx dev server plugin (react-data-xray/vite, react-data-xray/middleware) and update react-data-xray. Next.js: add app/%5F_rdx/command/[[...id]]/route.ts with export { GET, POST } from 'react-data-xray/next'.`,
      EXIT.server,
    );
  if (res.status === 403) throw new CliError(TOKEN_HINT, EXIT.server);
  // 실패(4xx)에도 처리기는 이유를 JSON 으로 준다. 본문이 없는 답(204)만 빈 객체다.
  if (res.status === 204 || !res.headers.get('content-type')?.startsWith('application/json')) return { status: res.status, body: {} };
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

export const listTabs = async (opts: CliOptions): Promise<TabInfo[]> => {
  const { body } = await call(opts, COMMAND_PATH);
  return Array.isArray(body.tabs) ? (body.tabs as TabInfo[]) : [];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CommandOutcome {
  command: CommandState;
  /** 다른 연결된 탭(tab 을 주지 않았을 때 dev 서버가 고르지 않은 탭) */
  others: TabInfo[];
}

const tabsOf = (body: Record<string, unknown>): TabInfo[] => (Array.isArray(body.tabs) ? (body.tabs as TabInfo[]) : []);

/** 탭에 명령을 맡기고 끝날 때까지 기다린다 */
export const runCommand = async (opts: CliOptions, op: CommandOp, name?: string): Promise<CommandOutcome> => {
  const created = await call(opts, COMMAND_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      op,
      ...(name !== undefined && { name }),
      ...(opts.tab !== undefined && { tab: opts.tab }),
      timeoutMs: opts.timeoutMs,
    }),
  });
  if (created.status !== 202) {
    const { error = `status ${created.status}`, reason } = created.body as { error?: string; reason?: string };
    if (reason === 'no-tab') throw new CliError(`No browser tab is connected. ${NO_TAB_HINT}`, EXIT.noTab);
    if (reason === 'ambiguous')
      throw new CliError(
        `Several tabs are open and none was focused in the last 2 minutes, so rdx will not guess. Pass --tab <id>:\n${formatTabs(tabsOf(created.body))}`,
        EXIT.pickTab,
      );
    if (reason === 'unknown-tab') throw new CliError(`${error}. Connected tabs:\n${formatTabs(tabsOf(created.body))}`, EXIT.noTab);
    throw new CliError(error, created.status === 400 ? EXIT.usage : EXIT.failed);
  }
  const others = (created.body.others as TabInfo[] | undefined) ?? [];
  const deadline = Date.now() + opts.timeoutMs;
  // 탭은 업로드·받아 가기 주기에 받아 가므로 결과를 짧은 간격으로 묻는다. 한 번에 하나씩 차례로 묻는다.
  const wait = async (current: CommandState): Promise<CommandState> => {
    if (current.status !== 'pending' && current.status !== 'sent') return current;
    if (Date.now() > deadline)
      throw new CliError(
        `Tab ${current.tab} did not ${current.status === 'pending' ? 'pick up' : 'finish'} the ${op} command within ${opts.timeoutMs / 1000}s. ${NO_TAB_HINT}`,
        EXIT.timeout,
      );
    await sleep(opts.pollMs ?? 250);
    const { status, body } = await call(opts, `${COMMAND_PATH}/${current.id}`);
    if (status !== 200) throw new CliError(String(body.error ?? `status ${status}`), EXIT.timeout);
    return wait(body as unknown as CommandState);
  };
  const command = await wait(created.body.command as CommandState);
  if (command.status === 'expired') throw new CliError(`Tab ${command.tab}: ${command.error ?? 'expired'}. ${NO_TAB_HINT}`, EXIT.timeout);
  if (command.status === 'failed') throw new CliError(`Tab ${command.tab} could not ${op}: ${command.error ?? 'failed'}`, EXIT.failed);
  return { command, others };
};

/** 보고서 폴더 안의 파일을 읽는다. relative 는 부르는 쪽이 이미 확인한 이름이다(폴더 밖을 가리키지 않는다) */
export const readDirFile = async (opts: CliOptions, relative: string): Promise<{ file: string; value: unknown }> => {
  const file = join(opts.cwd, opts.dir, relative);
  try {
    return { file, value: await readJsonFile(file) };
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT';
    throw new CliError(missing ? `No report at ${file}.` : `Could not read ${file}: ${String(error)}`, EXIT.failed);
  }
};

/** snapshot 으로 저장한 `.rdx/<name>.json` 을 읽는다. 이름은 snapshot 과 같은 규칙이라 경로를 만들 수 없다 */
export const readReportFile = async (opts: CliOptions, name: string): Promise<{ file: string; value: unknown }> => {
  if (!isReportName(name) || name.endsWith('.json'))
    throw new CliError(
      `Invalid report name: ${untrusted(name)} (use the name given to snapshot: letters, digits, ., _ or -, without .json)`,
      EXIT.usage,
    );
  return readDirFile(opts, `${name}.json`).catch((error: unknown) => {
    throw error instanceof CliError && error.message.startsWith('No report')
      ? new CliError(`${error.message} Save one with react-data-xray snapshot ${name}.`, EXIT.failed)
      : error;
  });
};
