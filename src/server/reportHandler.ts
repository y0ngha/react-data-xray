import { randomUUID, timingSafeEqual } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import {
  COMMAND_PATH,
  DEFAULT_REPORT_NAME,
  isReportName,
  isTabId,
  reportFileFor,
  SERVER_FILE,
  TAB_STALE_MS,
  TABS_INDEX,
} from '../shared/reportPath.js';
import {
  cancelCommand,
  createCommand,
  finishCommand,
  getCommand,
  isCliActive,
  isCommandLive,
  liveTabs,
  markCliActive,
  seeTab,
  storeFor,
  takeCommands,
  type Store,
  type TabNotice,
} from './commandQueue.js';

interface TabEntry {
  id: string;
  path: string;
  title: string;
  updatedAt: number;
  file: string;
}

/** 보고서 본문 상한. 넘으면 받지 않는다. */
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;

/** 본문이 MAX_REPORT_BYTES 를 넘었다. 413 으로 답한다 */
class TooLargeError extends Error {}

/**
 * 본문을 조각마다 세어 읽고, 상한을 넘으면 그 자리에서 그만 받는다(전부 받은 뒤 버리지 않게).
 * connect 미들웨어(`Readable.toWeb(req)`)와 Next 의 `request.body` 가 같이 쓴다.
 */
export const readBody = (body: ReadableStream<Uint8Array> | null): Promise<string> => {
  const reader = body?.getReader();
  if (!reader) return Promise.resolve('');
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const next = async (): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_REPORT_BYTES) {
      // 남은 본문은 받지 않는다.
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError('too large');
    }
    text += decoder.decode(value, { stream: true });
    return next();
  };
  return next();
};

export interface RdxReportOptions {
  /** 보고서를 쓸 폴더. 기본: 프로젝트 루트의 .rdx */
  dir?: string;
  /**
   * localhost 말고 dev 서버에 접속하는 호스트 이름(LAN IP 등). 여기 없는 Host 의 요청은 받지 않는다.
   * Vite 의 server.allowedHosts 와 같은 형식이다: '.example.com' 은 하위 도메인까지, true 는 모두 허용.
   */
  allowedHosts?: readonly string[] | true;
  /**
   * CLI·MCP 의 명령 경로(#69)를 어디서 쓸 수 있는지. 기본 'local': 같은 PC(루프백)에서 온 요청만 탭으로 등록하고 명령을 넘기며,
   * 명령 경로도 루프백에서만 받는다. 'lan' 이면 `vite --host` 로 연 LAN 의 기기도 탭으로 등록된다(같은 망의 다른 기기가 탭인 척
   * 명령을 받아 갈 수 있다. 명령 경로 자체는 여전히 토큰이 있어야 한다).
   */
  commands?: 'local' | 'lan';
  /** CLI·MCP 의 명령 경로. 미들웨어가 보고서 경로(`path`)에 맞춰 넘긴다. 기본 `/__rdx/command` */
  commandPath?: string;
}

/** 서버마다 다른 요청 객체(connect 의 IncomingMessage, Next 의 Web Request)에서 처리에 필요한 것만 꺼낸 것 */
export interface ReportRequest {
  method: string | undefined;
  /** 경로와 쿼리(`/__rdx/report?name=…`). 경로는 부르는 쪽이 이미 확인했다 */
  url: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  /** 본문. MAX_REPORT_BYTES 까지만 읽는다 */
  body: ReadableStream<Uint8Array> | null;
  /** TAB_HEADER 값. 탭의 받아 가기에만 붙는다 */
  tabHeader?: string;
  /** TOKEN_HEADER 값. CLI·MCP 의 명령 요청에만 붙는다 */
  token?: string;
  /** 요청을 보낸 쪽의 주소(소켓). 없으면(Next) Host 이름으로 루프백인지 본다 */
  remoteAddress?: string;
  /** 이 요청을 받은 dev 서버 자신의 주소(소켓의 로컬 주소에서 만든다). 없으면(Next) .server.json 에 주소를 쓰지 않는다 */
  serverUrl?: string;
}

export interface ReportReply {
  status: number;
  /** REPORT_HEADER 에 붙일 값. 없으면 붙이지 않는다 */
  mark?: '1' | 'forbidden-host';
  /** JSON 본문(명령 경로, 탭에 넘길 명령). 없으면 본문 없이 답한다 */
  body?: string;
  /** 탭에 CLI_ACTIVE_HEADER 를 붙여 5초마다 받아 가게 한다 */
  cliActive?: boolean;
}

/** 본문이 크거나 JSON 이 아니다 */
const failure = (error: unknown): ReportReply => ({ status: error instanceof TooLargeError ? 413 : 400, mark: '1' });

const json = (status: number, value: unknown): ReportReply => ({ status, mark: '1', body: JSON.stringify(value) });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostnameOf = (host: string | undefined): string => {
  try {
    return host ? new URL(`http://${host}`).hostname : '';
  } catch {
    return '';
  }
};

/**
 * Vite 와 같은 기준이다. IP 주소(LAN IP, 0.0.0.0)는 DNS 리바인딩으로 만들 수 없는 이름이라 허용한다.
 * 리바인딩은 공격자가 가진 도메인 이름을 127.0.0.1 로 풀어 쓰는 공격이다.
 */
const isAllowedHost = (name: string, allowedHosts: readonly string[] | true): boolean =>
  allowedHosts === true ||
  LOCAL_HOSTS.has(name) ||
  name.endsWith('.localhost') ||
  isIP(name.replace(/^\[|\]$/g, '')) !== 0 ||
  allowedHosts.some((h) => (h.startsWith('.') ? name === h.slice(1) || name.endsWith(h) : name === h));

/**
 * 다른 사이트가 이 주소로 보고서를 꾸며 보내면 AI 가 그 내용을 읽게 된다.
 * - Host 를 로컬 이름(또는 지정한 이름)으로 제한한다. DNS 리바인딩으로 공격 도메인을 127.0.0.1 로 풀면 Origin 과 Host 가
 *   둘 다 공격 도메인이 되어 같은 출처 검사를 통과하고, 이 처리기는 dev 서버의 Host 검사보다 먼저 돌 수 있다.
 * - 같은 출처의 JSON 만 받는다. 다른 출처의 JSON POST 는 preflight 가 필요한데 이 처리기는 CORS 를 허용하지 않는다.
 */
const isTrusted = ({ host, origin }: ReportRequest, allowedHosts: readonly string[] | true): boolean => {
  if (!isAllowedHost(hostnameOf(host), allowedHosts)) return false;
  if (!origin) return true;
  try {
    // 포트까지 비교한다. 같은 PC 의 다른 dev 서버(localhost:3000)는 다른 출처다.
    return new URL(origin).host === host;
  } catch {
    // 샌드박스 iframe 의 "null" 같은 값
    return false;
  }
};

const writeJson = async (file: string, value: unknown, mode?: number): Promise<void> => {
  // 임시 파일에 쓰고 이름을 바꾼다. 탭 여러 개가 동시에 보내거나 AI 가 읽는 도중이어도 잘린 JSON 을 보지 않는다.
  // Next dev 는 같은 모듈을 여러 번 평가하기도 해서(서버 번들마다) 모듈 안 순번으로는 이름이 겹칠 수 있다. 무작위 이름을 쓴다.
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
  await rename(temp, file);
  // umask 와 상관없이 맞춘다. Windows 는 권한 비트가 없어 무시한다.
  if (mode !== undefined) await chmod(file, mode).catch(() => undefined);
};

const readIndex = async (file: string): Promise<TabEntry[]> => {
  try {
    const list: unknown = JSON.parse(await readFile(file, 'utf8'));
    // 손상·조작된 항목(null, 숫자 아닌 시각, 잘못된 id)이 있어도 탭 저장이 계속 실패하지 않게 걸러 낸다.
    return Array.isArray(list)
      ? (list as TabEntry[]).filter((t) => typeof t === 'object' && t !== null && typeof t.id === 'string' && Number.isFinite(t.updatedAt))
      : [];
  } catch {
    return [];
  }
};

/** 지금 목록에 이 탭을 넣고 오래된 탭을 빼서 쓴다. 뺀 탭의 파일도 지운다. */
const mergeIndex = async (folder: string, indexFile: string, entry: TabEntry): Promise<void> => {
  const all = [...(await readIndex(indexFile)).filter((t) => t.id !== entry.id), entry];
  const stale = all.filter((t) => entry.updatedAt - t.updatedAt > TAB_STALE_MS && isTabId(t.id) && t.id !== TABS_INDEX);
  const staleSet = new Set(stale);
  await Promise.all(stale.map((t) => unlink(join(folder, reportFileFor(t.id))).catch(() => undefined)));
  await writeJson(
    indexFile,
    all.filter((t) => !staleSet.has(t)).sort((a, b) => b.updatedAt - a.updatedAt),
  );
};

const hasEntry = async (indexFile: string, entry: TabEntry): Promise<boolean> =>
  (await readIndex(indexFile)).some((t) => t.id === entry.id && t.updatedAt >= entry.updatedAt);

// 탭 목록은 읽고 고쳐 쓰므로 한 번에 하나씩 처리한다. 모듈이 여러 번 평가돼도 한 프로세스 안에서는 같은 큐를 쓰게 전역에 둔다.
const INDEX_QUEUE = Symbol.for('react-data-xray.tabIndexQueue');
const enqueueIndex = (run: () => Promise<void>): Promise<unknown> => {
  const holder = globalThis as { [INDEX_QUEUE]?: Promise<unknown> };
  const queued = (holder[INDEX_QUEUE] ?? Promise.resolve()).then(run, run);
  holder[INDEX_QUEUE] = queued;
  return queued;
};

/**
 * 탭 파일을 쓰고 탭 목록을 갱신하며, 오래 갱신이 없는 탭(닫힌 탭)의 파일은 지운다. 쓰기와 정리가 같은 큐 안이라 방금 쓴 파일을 옛 목록 기준으로 지우지 않는다.
 * 다른 프로세스가 같은 목록을 동시에 고쳐 써 이 탭이 빠졌으면 한 번 더 합쳐 쓴다. 그 사이에 또 덮이면 빠진 채로 남지만,
 * 열린 탭은 TAB_HEARTBEAT_MS 마다 다시 알리므로 다음 알림에 다시 들어간다.
 */
const updateTabIndex = (folder: string, entry: TabEntry, report: object): Promise<unknown> =>
  enqueueIndex(async () => {
    const dir = join(folder, 'tabs');
    await mkdir(dir, { recursive: true });
    await writeJson(join(folder, entry.file), { tab: entry, ...report });
    const indexFile = join(dir, `${TABS_INDEX}.json`);
    await mergeIndex(folder, indexFile, entry);
    if (!(await hasEntry(indexFile, entry))) await mergeIndex(folder, indexFile, entry);
  });

/** 탭이 보낸 값(탭 목록에 보이는 값). 페이지가 정한 값이라 길이만 자르고, 보여 주는 쪽(CLI)이 다듬는다 */
const tabNotice = (tab: string, query: URLSearchParams): TabNotice => {
  const ago = Number(query.get('focusedAgo') ?? Number.NaN);
  return {
    id: tab,
    path: (query.get('path') ?? '').slice(0, 300),
    title: (query.get('title') ?? '').slice(0, 200),
    // 보내지 않은 이전 브라우저 코드는 보이는 것으로 본다
    visible: query.get('visible') !== '0',
    ...(Number.isFinite(ago) && ago >= 0 && { focusedAgo: ago }),
  };
};

/** 이 탭에 맡긴 명령이 있으면 본문으로 넘긴다. 없으면 본문 없이 답한다(대부분의 주기) */
const replyWithCommands = (store: Store, tab: string): ReportReply => {
  const now = Date.now();
  const commands = takeCommands(store, tab, now);
  const cliActive = isCliActive(store, now);
  return commands.length > 0 ? { ...json(200, { commands }), cliActive } : { status: 204, mark: '1', cliActive };
};

/** 토큰이 들어 있어 이 사용자만 읽게 한다 */
const SERVER_FILE_MODE = 0o600;

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * 명령 경로의 토큰과 dev 서버 자신의 주소를 SERVER_FILE 에 적는다. CLI 는 이 파일에서 토큰을 읽고, `--url` 이 없으면 주소도 읽는다.
 * 주소는 요청이 보낸 Host·Origin 이 아니라 서버가 받은 소켓에서 만든 것만 쓴다. LAN 의 다른 기기가 보낸 Origin 을 적으면
 * CLI 가 토큰을 그 기기로 보내게 된다. 주소를 모르면(Next) 지난번에 적은 주소를 그대로 둔다(없으면 CLI 가 --url 을 묻는다).
 * 내용이 바뀌었거나 파일이 지워졌을 때만 쓰고, 쓰기에 성공한 뒤에야 기억한다.
 */
const writeServerFile = async (folder: string, store: Store, serverUrl: string | undefined, commandPath: string): Promise<void> => {
  const file = join(folder, SERVER_FILE);
  if (serverUrl) store.serverUrl = serverUrl;
  if (!store.serverUrl) {
    const saved = (await readFile(file, 'utf8').then(JSON.parse, () => null)) as { url?: unknown } | null;
    if (typeof saved?.url === 'string') store.serverUrl = saved.url;
  }
  // CLI 는 commandPath 로 보낸다(보고서 경로를 바꿨으면 명령 경로도 따라 바뀐다).
  const content = JSON.stringify({ token: store.token, url: store.serverUrl, commandPath });
  if (store.written === content && (await exists(file))) return;
  await mkdir(folder, { recursive: true });
  // 실행할 때마다 바뀌는 파일이라 저장소에 올리지 않는다. 이미 있으면 그대로 둔다.
  await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
  await writeJson(file, { token: store.token, url: store.serverUrl, commandPath, updatedAt: Date.now() }, SERVER_FILE_MODE);
  store.written = content;
};

const LOOPBACK_ADDRESS = /^(127\.|::1$|::ffff:127\.)/;

/**
 * 같은 PC 에서 온 요청인지. 소켓 주소가 있으면(connect 미들웨어) 그것으로, 없으면(Next 의 Web Request) Host 이름으로 본다.
 * Host 는 보내는 쪽이 꾸밀 수 있어, Next 에서는 LAN 의 기기가 Host 를 localhost 로 꾸며 보내는 것까지는 막지 못한다.
 */
const isLocalPeer = (req: ReportRequest): boolean => {
  if (req.remoteAddress !== undefined) return LOOPBACK_ADDRESS.test(req.remoteAddress);
  const name = hostnameOf(req.host);
  return name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '[::1]';
};

const writeReport = async (
  folder: string,
  commandPath: string,
  req: ReportRequest,
  query: URLSearchParams,
  commands: boolean,
): Promise<ReportReply> => {
  const name = query.get('name');
  const tab = query.get('tab');
  const report: unknown = JSON.parse(await readBody(req.body));
  const store = storeFor(folder);
  // .rdx 와 .gitignore 도 여기서 만든다.
  await writeServerFile(folder, store, req.serverUrl, commandPath);
  if (tab !== null && typeof report === 'object' && report !== null) {
    const notice = tabNotice(tab, query);
    const entry: TabEntry = { id: tab, path: notice.path, title: notice.title, updatedAt: Date.now(), file: reportFileFor(tab) };
    await updateTabIndex(folder, entry, report);
    // 탭 파일은 어디서 온 탭이든 쓰지만, 명령을 받는 탭으로는 같은 PC 의 탭만 등록한다(commands: 'lan' 이면 LAN 도).
    // JSON 본문의 POST 는 다른 사이트가 preflight 없이 보낼 수 없어, TAB_HEADER 없이도 탭 알림으로 받는다.
    if (!commands) {
      if (query.get('idle') !== '1') await writeJson(join(folder, `${DEFAULT_REPORT_NAME}.json`), report);
      return { status: 204, mark: '1' };
    }
    seeTab(store, notice, Date.now());
    // 열려 있다는 알림만이면 "가장 최근에 바뀐 탭"을 바꾸지 않는다.
    if (query.get('idle') !== '1') await writeJson(join(folder, `${DEFAULT_REPORT_NAME}.json`), report);
    return replyWithCommands(store, tab);
  }
  await writeJson(join(folder, `${name ?? DEFAULT_REPORT_NAME}.json`), report);
  return { status: 204, mark: '1' };
};

/** 탭이 맡은 명령을 마치고 결과를 알린다: `POST /__rdx/report?command=<id>&tab=<id>` */
const writeCommandResult = async (folder: string, req: ReportRequest, query: URLSearchParams): Promise<ReportReply> => {
  const id = query.get('command') ?? '';
  const tab = query.get('tab') ?? '';
  const result: unknown = JSON.parse(await readBody(req.body));
  return finishCommand(storeFor(folder), id, tab, result, Date.now()) ? { status: 204, mark: '1' } : { status: 404, mark: '1' };
};

const sameToken = (given: string | undefined, token: string): boolean => {
  if (given === undefined) return false;
  const [a, b] = [Buffer.from(given), Buffer.from(token)];
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * CLI·MCP 가 쓰는 명령 경로(#69). 모든 요청에 SERVER_FILE 의 토큰(TOKEN_HEADER)이 있어야 한다. 그 파일을 읽을 수 있는
 * 같은 PC 의 도구만 쓰게 해, `vite --host` 로 연 LAN 의 다른 기기나 리바인딩한 사이트가 탭을 조작하지 못하게 한다.
 * - `GET /__rdx/command`: 연결된 탭 목록
 * - `POST /__rdx/command` `{ op: 'reset' | 'snapshot', name?, tab?, timeoutMs? }`: 탭에 명령을 맡긴다(202, 명령 id)
 * - `GET /__rdx/command/<id>`: 명령이 끝났는지
 * - `DELETE /__rdx/command/<id>`: 기다리기를 그만둔다(시간 초과·Ctrl+C·MCP 취소). 아직 실행하지 않았으면 실행하지 않는다
 * 탭은 업로드·받아 가기 응답으로 명령을 받아 window.__RDX__ 의 reset·snapshot 을 부른다.
 */
const handleCommand = async (
  folder: string,
  commandPath: string,
  req: ReportRequest,
  path: string,
  commands: boolean,
): Promise<ReportReply> => {
  if (!commands)
    return json(403, {
      error: 'not-local',
      message: "the command path only accepts requests from this machine (rdx({ commands: 'lan' }) to allow LAN)",
    });
  const store = storeFor(folder);
  // 토큰 파일이 아직 없으면(브라우저가 아직 오지 않았으면) 지금 써서 CLI 가 다시 읽고 보내게 한다.
  await writeServerFile(folder, store, req.serverUrl, commandPath);
  if (!sameToken(req.token, store.token)) return json(403, { error: 'token', message: `missing or wrong ${SERVER_FILE} token` });
  const now = Date.now();
  markCliActive(store, now);
  const id = path.slice(commandPath.length + 1);
  if (req.method === 'GET') {
    if (path === commandPath) return json(200, { tabs: liveTabs(store, now) });
    const command = getCommand(store, id, now);
    return command ? json(200, command) : json(404, { error: `unknown or expired command: ${id}` });
  }
  if (req.method === 'DELETE') {
    const cancelled = path === commandPath ? undefined : cancelCommand(store, id, now);
    return cancelled ? json(200, cancelled) : json(404, { error: `unknown or expired command: ${id}` });
  }
  if (path !== commandPath) return { status: 405, mark: '1' };
  if (!req.contentType?.startsWith('application/json')) return { status: 403, mark: '1' };
  const created = createCommand(store, JSON.parse(await readBody(req.body)), now);
  if (!created.ok)
    return json(created.status, { error: created.error, reason: created.reason, ...(created.tabs && { tabs: created.tabs }) });
  return json(202, { command: created.command, others: created.others });
};

/**
 * rdx 보고서 요청(GET 은 있는지 묻기, POST 는 쓰기)과 명령 경로를 처리한다. connect 미들웨어와 Next.js route handler 가 같이 쓴다.
 * 보고서는 `<root>/<dir>/report.json`(이름을 주면 `<이름>.json`, 탭은 `tabs/<id>.json`)에 쓴다.
 */
export const createReportHandler = (
  root: string,
  { dir = '.rdx', allowedHosts = [], commands = 'local', commandPath = COMMAND_PATH }: RdxReportOptions = {},
) => {
  const folder = join(root, dir);
  return async (req: ReportRequest): Promise<ReportReply> => {
    // 브라우저가 "처리기는 있지만 이 주소는 막혔다"를 알고 안내할 수 있게 표시한다.
    if (!isTrusted(req, allowedHosts)) return { status: 403, mark: 'forbidden-host' };
    const url = new URL(req.url, 'http://x');
    const query = url.searchParams;
    // 명령을 주고받는 쪽(탭 등록·받아 가기·결과, 명령 경로)은 같은 PC 에서 온 요청만 받는다(commands: 'lan' 이면 LAN 도).
    const commandsAllowed = commands === 'lan' || isLocalPeer(req);
    if (url.pathname === commandPath || url.pathname.startsWith(`${commandPath}/`))
      return handleCommand(folder, commandPath, req, url.pathname, commandsAllowed).catch(failure);
    const tab = query.get('tab');
    if (req.method === 'GET') {
      // TAB_HEADER 가 없는 GET(다른 사이트의 <img> 등)은 아무것도 바꾸지 않는 핸드셰이크로 답한다.
      const fromTab = commandsAllowed && req.tabHeader === '1' && tab !== null && isTabId(tab) && tab !== TABS_INDEX;
      // 탭이 실행 직전에 명령이 아직 살아 있는지 묻는다(204 면 실행, 410 이면 CLI 가 포기했다).
      if (fromTab && query.has('command'))
        return { status: isCommandLive(storeFor(folder), query.get('command')!, tab, Date.now()) ? 204 : 410, mark: '1' };
      // 탭이 맡은 명령을 받아 간다(보고서가 그대로라 올리지 않는 주기). 열려 있다는 알림도 된다.
      if (fromTab) {
        const store = storeFor(folder);
        await writeServerFile(folder, store, req.serverUrl, commandPath);
        seeTab(store, tabNotice(tab, query), Date.now());
        return replyWithCommands(store, tab);
      }
      // 브라우저가 보고서를 보내기 전에 이 처리기가 있는지 묻는다(없으면 프록시가 원격으로 넘길 수 있다).
      return { status: 204, mark: '1' };
    }
    if (!req.contentType?.startsWith('application/json')) return { status: 403, mark: '1' };
    if (query.has('command')) return commandsAllowed ? writeCommandResult(folder, req, query).catch(failure) : { status: 403, mark: '1' };
    // window.__RDX__.snapshot(이름) 은 ?name= 으로 따로 저장한다. 파일 이름이 되므로 경로를 만들 수 있는 글자는 받지 않는다.
    const name = query.get('name');
    if (name !== null && !isReportName(name)) return { status: 400, mark: '1' };
    if (tab !== null && (!isTabId(tab) || tab === TABS_INDEX || name !== null)) return { status: 400, mark: '1' };
    return writeReport(folder, commandPath, req, query, commandsAllowed).catch(failure);
  };
};
