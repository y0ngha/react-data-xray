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
// 동시에 들어온 보고서가 같은 임시 파일 이름을 쓰지 않게 붙이는 순번
let writeSeq = 0;

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
  /** 본문을 읽는다. MAX_REPORT_BYTES 를 넘으면 거절(reject)한다 */
  readBody: () => Promise<string>;
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

// 탭 목록은 읽고 고쳐 쓰므로 한 번에 하나씩 처리한다.
let indexQueue: Promise<unknown> = Promise.resolve();

const writeJson = async (file: string, value: unknown): Promise<void> => {
  // 임시 파일에 쓰고 이름을 바꾼다. 탭 여러 개가 동시에 보내거나 AI 가 읽는 도중이어도 잘린 JSON 을 보지 않는다.
  const temp = `${file}.${process.pid}.${writeSeq++}.tmp`;
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

/** 탭 파일을 쓰고 탭 목록을 갱신하며, 오래 갱신이 없는 탭(닫힌 탭)의 파일은 지운다. 쓰기와 정리가 같은 큐 안이라 방금 쓴 파일을 옛 목록 기준으로 지우지 않는다. */
const updateTabIndex = (folder: string, entry: TabEntry, report: object): Promise<unknown> => {
  const run = async () => {
    const dir = join(folder, 'tabs');
    await mkdir(dir, { recursive: true });
    await writeJson(join(folder, entry.file), { tab: entry, ...report });
    const indexFile = join(dir, `${TABS_INDEX}.json`);
    const now = entry.updatedAt;
    const all = [...(await readIndex(indexFile)).filter((t) => t.id !== entry.id), entry];
    const stale = all.filter((t) => now - t.updatedAt > TAB_STALE_MS && isTabId(t.id) && t.id !== TABS_INDEX);
    const staleSet = new Set(stale);
    await Promise.all(stale.map((t) => unlink(join(folder, reportFileFor(t.id))).catch(() => undefined)));
    await writeJson(
      indexFile,
      all.filter((t) => !staleSet.has(t)).sort((a, b) => b.updatedAt - a.updatedAt),
    );
  };
  indexQueue = indexQueue.then(run, run);
  return indexQueue;
};

const writeReport = async (folder: string, req: ReportRequest, query: URLSearchParams): Promise<ReportReply> => {
  const name = query.get('name');
  const tab = query.get('tab');
  const report: unknown = JSON.parse(await req.readBody());
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
    return writeReport(folder, req, query).catch(() => ({ status: 400, mark: '1' }));
  };
};
