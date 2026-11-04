import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { COMMAND_PATH, REPORT_HEADER, REPORT_PATH } from '../shared/reportPath.js';
import { createReportHandler, type RdxReportOptions } from './reportHandler.js';

export type { RdxReportOptions };

/** HTTP/1 은 Host, HTTP/2(https dev 서버)는 :authority 로 온다. */
const hostOf = (req: IncomingMessage): string | undefined => req.headers.host ?? (req.headers[':authority'] as string | undefined);

/** 보고서 경로와 명령 경로(`/__rdx/command`, `/__rdx/command/<id>`) */
const isRdxPath = (path: string): boolean => path === REPORT_PATH || path === COMMAND_PATH || path.startsWith(`${COMMAND_PATH}/`);

/**
 * rdx 보고서를 받아 `<root>/.rdx/report.json`(이름을 주면 `<이름>.json`)에 쓰는 connect 미들웨어.
 * webpack: `devServer.setupMiddlewares = (m, server) => { server.app.use(rdxReportMiddleware()); return m; }`
 */
export const rdxReportMiddleware = (root = process.cwd(), options: RdxReportOptions = {}) => {
  const handle = createReportHandler(root, options);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url ?? '';
    if (!isRdxPath(url.split('?')[0]) || (req.method !== 'GET' && req.method !== 'POST')) return next();
    void handle({
      method: req.method,
      url,
      host: hostOf(req),
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      // GET 에는 본문이 없다. 본문을 읽을 때만 Web 스트림으로 바꾼다.
      body: req.method === 'POST' ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    }).then(({ status, mark, body }) => {
      if (mark) res.setHeader(REPORT_HEADER, mark);
      if (body !== undefined) res.setHeader('content-type', 'application/json');
      res.statusCode = status;
      res.end(body);
    });
  };
};
