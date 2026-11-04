import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import { DEFAULT_REPORT_NAME, isReportName, isTabId, reportFileFor, TAB_STALE_MS, TABS_INDEX } from '../shared/reportPath.js';

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
}

export interface ReportReply {
  status: number;
  /** REPORT_HEADER 에 붙일 값. 없으면 붙이지 않는다 */
  mark?: '1' | 'forbidden-host';
}

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

const writeJson = async (file: string, value: unknown): Promise<void> => {
  // 임시 파일에 쓰고 이름을 바꾼다. 탭 여러 개가 동시에 보내거나 AI 가 읽는 도중이어도 잘린 JSON 을 보지 않는다.
  // Next dev 는 같은 모듈을 여러 번 평가하기도 해서(서버 번들마다) 모듈 안 순번으로는 이름이 겹칠 수 있다. 무작위 이름을 쓴다.
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
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

const writeReport = async (folder: string, req: ReportRequest, query: URLSearchParams): Promise<ReportReply> => {
  const name = query.get('name');
  const tab = query.get('tab');
  const report: unknown = JSON.parse(await readBody(req.body));
  await mkdir(folder, { recursive: true });
  // 실행할 때마다 바뀌는 파일이라 저장소에 올리지 않는다. 이미 있으면 그대로 둔다.
  await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
  if (tab !== null && typeof report === 'object' && report !== null) {
    const entry: TabEntry = {
      id: tab,
      path: (query.get('path') ?? '').slice(0, 300),
      title: (query.get('title') ?? '').slice(0, 200),
      updatedAt: Date.now(),
      file: reportFileFor(tab),
    };
    await updateTabIndex(folder, entry, report);
    // 열려 있다는 알림만이면 "가장 최근에 바뀐 탭"을 바꾸지 않는다.
    if (query.get('idle') === '1') return { status: 204, mark: '1' };
  }
  await writeJson(join(folder, `${name ?? DEFAULT_REPORT_NAME}.json`), report);
  return { status: 204, mark: '1' };
};

/**
 * rdx 보고서 요청(GET 은 있는지 묻기, POST 는 쓰기)을 처리한다. connect 미들웨어와 Next.js route handler 가 같이 쓴다.
 * 보고서는 `<root>/<dir>/report.json`(이름을 주면 `<이름>.json`, 탭은 `tabs/<id>.json`)에 쓴다.
 */
export const createReportHandler = (root: string, { dir = '.rdx', allowedHosts = [] }: RdxReportOptions = {}) => {
  const folder = join(root, dir);
  return async (req: ReportRequest): Promise<ReportReply> => {
    // 브라우저가 "처리기는 있지만 이 주소는 막혔다"를 알고 안내할 수 있게 표시한다.
    if (!isTrusted(req, allowedHosts)) return { status: 403, mark: 'forbidden-host' };
    // 브라우저가 보고서를 보내기 전에 이 처리기가 있는지 묻는다(없으면 프록시가 원격으로 넘길 수 있다).
    if (req.method === 'GET') return { status: 204, mark: '1' };
    if (!req.contentType?.startsWith('application/json')) return { status: 403, mark: '1' };
    // window.__RDX__.snapshot(이름) 은 ?name= 으로 따로 저장한다. 파일 이름이 되므로 경로를 만들 수 있는 글자는 받지 않는다.
    const query = new URL(req.url, 'http://x').searchParams;
    const name = query.get('name');
    if (name !== null && !isReportName(name)) return { status: 400, mark: '1' };
    const tab = query.get('tab');
    if (tab !== null && (!isTabId(tab) || tab === TABS_INDEX || name !== null)) return { status: 400, mark: '1' };
    return writeReport(folder, req, query).catch((error: unknown) => ({ status: error instanceof TooLargeError ? 413 : 400, mark: '1' }));
  };
};
