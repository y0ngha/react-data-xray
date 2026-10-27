import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

// 브라우저 쪽(src/core/report/reportApi.ts)과 같은 경로
const REPORT_PATH = '/__rdx/report';
const MAX_BYTES = 5 * 1024 * 1024;

export interface RdxReportOptions {
  /** 보고서를 쓸 폴더. 기본: 프로젝트 루트의 .rdx */
  dir?: string;
}

/**
 * 다른 사이트가 이 주소로 보고서를 꾸며 보내면 AI 가 그 내용을 읽게 된다. 같은 출처의 JSON 만 받는다.
 * (다른 출처의 JSON POST 는 preflight 가 필요한데 이 처리기는 CORS 를 허용하지 않는다.)
 */
const isSameOrigin = (req: IncomingMessage): boolean => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BYTES) reject(new Error('too large'));
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
export const rdxReportMiddleware = (root = process.cwd(), { dir = '.rdx' }: RdxReportOptions = {}) => {
  const folder = join(root, dir);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== REPORT_PATH) return next();
    if (!isSameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 403);
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
