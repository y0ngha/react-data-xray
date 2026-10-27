import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { REPORT_HEADER, REPORT_PATH } from '../shared/reportPath.js';

const MAX_BYTES = 5 * 1024 * 1024;

export interface RdxReportOptions {
  /** 보고서를 쓸 폴더. 기본: 프로젝트 루트의 .rdx */
  dir?: string;
  /** localhost 말고 dev 서버에 접속하는 호스트 이름(LAN IP 등). 여기 없는 Host 의 요청은 받지 않는다. */
  allowedHosts?: string[];
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
 * 다른 사이트가 이 주소로 보고서를 꾸며 보내면 AI 가 그 내용을 읽게 된다.
 * - Host 를 로컬 이름(또는 지정한 이름)으로 제한한다. DNS 리바인딩으로 공격 도메인을 127.0.0.1 로 풀면 Origin 과 Host 가
 *   둘 다 공격 도메인이 되어 같은 출처 검사를 통과하고, 이 미들웨어는 Vite 의 Host 검사보다 먼저 돈다.
 * - 같은 출처의 JSON 만 받는다. 다른 출처의 JSON POST 는 preflight 가 필요한데 이 처리기는 CORS 를 허용하지 않는다.
 */
const isTrusted = (req: IncomingMessage, allowedHosts: readonly string[]): boolean => {
  const name = hostnameOf(req.headers.host);
  if (!LOCAL_HOSTS.has(name) && !name.endsWith('.localhost') && !allowedHosts.includes(name)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).hostname === name;
  } catch {
    // 샌드박스 iframe 의 "null" 같은 값
    return false;
  }
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length <= MAX_BYTES) return;
      // 거절한 뒤에도 계속 받아 쌓지 않게 연결을 끊는다.
      req.destroy();
      reject(new Error('too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const reply = (res: ServerResponse, status: number): void => {
  res.statusCode = status;
  res.end();
};

/**
 * rdx 보고서를 받아 `<root>/.rdx/report.json` 에 쓰는 connect 미들웨어.
 * webpack: `devServer.setupMiddlewares = (m, server) => { server.app.use(rdxReportMiddleware()); return m; }`
 */
export const rdxReportMiddleware = (root = process.cwd(), { dir = '.rdx', allowedHosts = [] }: RdxReportOptions = {}) => {
  const folder = join(root, dir);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.url?.split('?')[0] !== REPORT_PATH || (req.method !== 'GET' && req.method !== 'POST')) return next();
    if (!isTrusted(req, allowedHosts)) return reply(res, 403);
    // 브라우저가 보고서를 보내기 전에 이 미들웨어가 있는지 묻는다(없으면 프록시가 원격으로 넘길 수 있다).
    res.setHeader(REPORT_HEADER, '1');
    if (req.method === 'GET') return reply(res, 204);
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 403);
    readBody(req)
      .then(async (text) => {
        const report: unknown = JSON.parse(text);
        await mkdir(folder, { recursive: true });
        // 실행할 때마다 바뀌는 파일이라 저장소에 올리지 않는다.
        await writeFile(join(folder, '.gitignore'), '*\n');
        await writeFile(join(folder, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        reply(res, 204);
      })
      .catch(() => reply(res, 400));
  };
};
