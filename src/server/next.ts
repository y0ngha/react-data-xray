import { CLI_ACTIVE_HEADER, REPORT_HEADER, TAB_HEADER, TOKEN_HEADER } from '../shared/reportPath.js';
import { createReportHandler, type RdxReportOptions } from './reportHandler.js';

export type { RdxReportOptions };

type RouteHandler = (request: Request) => Promise<Response>;

export interface RdxReportRoute {
  GET: RouteHandler;
  POST: RouteHandler;
  /** 명령 경로에서 CLI 가 기다리기를 그만둘 때 쓴다(`DELETE /__rdx/command/<id>`) */
  DELETE: RouteHandler;
}

const respond = (status: number, mark?: string, body?: string, cliActive?: boolean): Response =>
  new Response(body ?? null, {
    status,
    headers: {
      ...(mark && { [REPORT_HEADER]: mark }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(cliActive && { [CLI_ACTIVE_HEADER]: '1' }),
    },
  });

/**
 * Next.js App Router 의 route handler. dev 서버(`next dev`)에서만 보고서를 받고, 그 밖에서는 404 로 답해 production 에서 열리지 않는다.
 * 미들웨어(`react-data-xray/middleware`)와 같은 처리기를 쓴다(Host·Origin 검사, 원자적 쓰기, `.gitignore`, 탭 파일).
 *
 * `app/%5F_rdx/report/route.ts`: `export { GET, POST } from 'react-data-xray/next'`
 * (`_` 로 시작하는 폴더는 Next 가 라우팅에서 빼므로 첫 `_` 를 `%5F` 로 쓴다.)
 * CLI·MCP 의 명령 경로(`/__rdx/command`)도 같은 처리기다: `app/%5F_rdx/command/[[...id]]/route.ts` 에
 * `export { GET, POST, DELETE } from 'react-data-xray/next'` 를 둔다. Next 의 Web Request 에는 소켓이 없어 dev 서버 주소를
 * 알 수 없으므로 CLI 에 `--url` 이 필요하고, 같은 PC 인지는 Host 이름으로만 본다.
 * 옵션이 필요하면 `export const { GET, POST } = createRdxReportRoute(process.cwd(), { allowedHosts: [...] })`.
 */
export const createRdxReportRoute = (root = process.cwd(), options: RdxReportOptions = {}): RdxReportRoute => {
  const handle = createReportHandler(root, options);
  const route: RouteHandler = async (request) => {
    // next build 가 만든 서버(next start)와 테스트에서는 받지 않는다. 경로가 있다는 표시도 주지 않는다.
    if (process.env.NODE_ENV !== 'development') return respond(404);
    const { status, mark, body, cliActive } = await handle({
      method: request.method,
      url: request.url,
      host: request.headers.get('host') ?? undefined,
      origin: request.headers.get('origin') ?? undefined,
      contentType: request.headers.get('content-type') ?? undefined,
      body: request.body,
      tabHeader: request.headers.get(TAB_HEADER) ?? undefined,
      token: request.headers.get(TOKEN_HEADER) ?? undefined,
    });
    return respond(status, mark, body, cliActive);
  };
  return { GET: route, POST: route, DELETE: route };
};

// 모듈을 불러오기만 해서는 아무것도 만들지 않게, 처음 요청이 올 때 만든다.
let defaultRoute: RdxReportRoute | undefined;
const getDefaultRoute = (): RdxReportRoute => (defaultRoute ??= createRdxReportRoute());

/** `export { GET, POST } from 'react-data-xray/next'` 로 쓰는 기본 처리기. 보고서는 `next dev` 를 실행한 폴더의 `.rdx` 에 쓴다. */
export const GET: RouteHandler = (request) => getDefaultRoute().GET(request);
export const POST: RouteHandler = (request) => getDefaultRoute().POST(request);
export const DELETE: RouteHandler = (request) => getDefaultRoute().DELETE(request);
