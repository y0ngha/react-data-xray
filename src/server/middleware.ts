import type { IncomingMessage, ServerResponse } from 'node:http';

import { REPORT_HEADER, REPORT_PATH } from '../shared/reportPath.js';
import { createReportHandler, MAX_REPORT_BYTES, type RdxReportOptions } from './reportHandler.js';

export type { RdxReportOptions };

/** HTTP/1 은 Host, HTTP/2(https dev 서버)는 :authority 로 온다. */
const hostOf = (req: IncomingMessage): string | undefined => req.headers.host ?? (req.headers[':authority'] as string | undefined);

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_REPORT_BYTES) return;
      // 거절한 뒤에도 계속 받아 쌓지 않게 연결을 끊는다.
      req.destroy();
      reject(new Error('too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

/**
 * rdx 보고서를 받아 `<root>/.rdx/report.json`(이름을 주면 `<이름>.json`)에 쓰는 connect 미들웨어.
 * webpack: `devServer.setupMiddlewares = (m, server) => { server.app.use(rdxReportMiddleware()); return m; }`
 */
export const rdxReportMiddleware = (root = process.cwd(), options: RdxReportOptions = {}) => {
  const handle = createReportHandler(root, options);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.url?.split('?')[0] !== REPORT_PATH || (req.method !== 'GET' && req.method !== 'POST')) return next();
    void handle({
      method: req.method,
      url: req.url,
      host: hostOf(req),
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      readBody: () => readBody(req),
    }).then(({ status, mark }) => {
      if (mark) res.setHeader(REPORT_HEADER, mark);
      res.statusCode = status;
      res.end();
    });
  };
};
