import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { CLI_ACTIVE_HEADER, COMMAND_PATH, REPORT_HEADER, REPORT_PATH, TAB_HEADER, TOKEN_HEADER } from '../shared/reportPath.js';
import { createReportHandler, type RdxReportOptions } from './reportHandler.js';

export type { RdxReportOptions };

/** HTTP/1 은 Host, HTTP/2(https dev 서버)는 :authority 로 온다. */
const hostOf = (req: IncomingMessage): string | undefined => req.headers.host ?? (req.headers[':authority'] as string | undefined);

/**
 * 이 요청을 받은 dev 서버 자신의 주소. 요청의 Host·Origin 은 보내는 쪽이 정하므로 쓰지 않고, 소켓이 받은 로컬 주소와 포트로 만든다.
 * 루프백으로 받았으면 localhost 로 쓴다(CLI 가 같은 PC 에서 붙는다).
 */
export const serverUrlOf = (req: IncomingMessage): string | undefined => {
  const { localAddress, localPort } = req.socket ?? {};
  if (!localAddress || !localPort) return undefined;
  const secure = (req.socket as { encrypted?: boolean }).encrypted === true || req.headers[':scheme'] === 'https';
  const loopback = /^(127\.|::1$|::ffff:127\.)/.test(localAddress);
  const v4 = localAddress.replace(/^::ffff:/, '');
  const host = loopback ? 'localhost' : v4.includes(':') ? `[${v4}]` : v4;
  return `${secure ? 'https' : 'http'}://${host}:${localPort}`;
};

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
    if (!isRdxPath(url.split('?')[0]) || (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE')) return next();
    void handle({
      method: req.method,
      url,
      host: hostOf(req),
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      tabHeader: req.headers[TAB_HEADER] as string | undefined,
      token: req.headers[TOKEN_HEADER] as string | undefined,
      remoteAddress: req.socket?.remoteAddress,
      serverUrl: serverUrlOf(req),
      // GET 에는 본문이 없다. 본문을 읽을 때만 Web 스트림으로 바꾼다.
      body: req.method === 'POST' ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    }).then(({ status, mark, body, cliActive }) => {
      if (mark) res.setHeader(REPORT_HEADER, mark);
      if (cliActive) res.setHeader(CLI_ACTIVE_HEADER, '1');
      if (body !== undefined) res.setHeader('content-type', 'application/json');
      res.statusCode = status;
      res.end(body);
    });
  };
};
