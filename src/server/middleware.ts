import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { REPORT_HEADER, REPORT_PATH } from '../shared/reportPath.js';
import { createReportHandler, type RdxReportOptions } from './reportHandler.js';

export type { RdxReportOptions };

export interface RdxMiddlewareOptions extends RdxReportOptions {
  /**
   * 보고서를 받을 경로. 브라우저 쪽 `configure({ reportPath })` 와 같게 둔다. 기본 `/__rdx/report`.
   * 쿼리 없이 '/' 로 시작해야 한다.
   */
  path?: string;
}

/** 맞지 않는 경로는 실수로 앱의 다른 경로를 가로채지 않게 받지 않는다 */
const reportPathOf = (path: string | undefined): string => {
  if (path === undefined) return REPORT_PATH;
  if (/^\/(?!\/)[^\s?#]*$/.test(path)) return path;
  throw new Error(`[react-data-xray] path must start with '/' and have no query: ${path}`);
};

/** HTTP/1 은 Host, HTTP/2(https dev 서버)는 :authority 로 온다. */
const hostOf = (req: IncomingMessage): string | undefined => req.headers.host ?? (req.headers[':authority'] as string | undefined);

/**
 * rdx 보고서를 받아 `<root>/.rdx/report.json`(이름을 주면 `<이름>.json`)에 쓰는 connect 미들웨어.
 * 경로를 바꾸려면 `{ path }`(브라우저의 `configure({ reportPath })` 와 같게).
 * webpack: `devServer.setupMiddlewares = (m, server) => { server.app.use(rdxReportMiddleware()); return m; }`
 */
export const rdxReportMiddleware = (root = process.cwd(), { path, ...options }: RdxMiddlewareOptions = {}) => {
  const reportPath = reportPathOf(path);
  const handle = createReportHandler(root, options);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.url?.split('?')[0] !== reportPath || (req.method !== 'GET' && req.method !== 'POST')) return next();
    void handle({
      method: req.method,
      url: req.url,
      host: hostOf(req),
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      // GET 에는 본문이 없다. 본문을 읽을 때만 Web 스트림으로 바꾼다.
      body: req.method === 'POST' ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    }).then(({ status, mark }) => {
      if (mark) res.setHeader(REPORT_HEADER, mark);
      res.statusCode = status;
      res.end();
    });
  };
};
