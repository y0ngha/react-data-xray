import { REPORT_HEADER } from '../shared/reportPath.js';
import { createReportHandler, MAX_REPORT_BYTES, type RdxReportOptions } from './reportHandler.js';

export type { RdxReportOptions };

type RouteHandler = (request: Request) => Promise<Response>;

export interface RdxReportRoute {
  GET: RouteHandler;
  POST: RouteHandler;
}

/** 본문을 조각마다 세어 읽고, 상한을 넘으면 그 자리에서 그만 받는다(전부 받은 뒤 버리지 않게). */
const readBody = (request: Request): Promise<string> => {
  const reader = request.body?.getReader();
  if (!reader) return Promise.resolve('');
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const next = async (): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_REPORT_BYTES) {
      await reader.cancel();
      throw new Error('too large');
    }
    text += decoder.decode(value, { stream: true });
    return next();
  };
  return next();
};

const respond = (status: number, mark?: string): Response => new Response(null, { status, headers: mark ? { [REPORT_HEADER]: mark } : {} });

/**
 * Next.js App Router 의 route handler. dev 서버(`next dev`)에서만 보고서를 받고, 그 밖에서는 404 로 답해 production 에서 열리지 않는다.
 * 미들웨어(`react-data-xray/middleware`)와 같은 처리기를 쓴다(Host·Origin 검사, 원자적 쓰기, `.gitignore`, 탭 파일).
 *
 * `app/%5F_rdx/report/route.ts`: `export { GET, POST } from 'react-data-xray/next'`
 * (`_` 로 시작하는 폴더는 Next 가 라우팅에서 빼므로 첫 `_` 를 `%5F` 로 쓴다.)
 * 옵션이 필요하면 `export const { GET, POST } = createRdxReportRoute(process.cwd(), { allowedHosts: [...] })`.
 */
export const createRdxReportRoute = (root = process.cwd(), options: RdxReportOptions = {}): RdxReportRoute => {
  const handle = createReportHandler(root, options);
  const route: RouteHandler = async (request) => {
    // next build 가 만든 서버(next start)와 테스트에서는 받지 않는다. 경로가 있다는 표시도 주지 않는다.
    if (process.env.NODE_ENV !== 'development') return respond(404);
    const { status, mark } = await handle({
      method: request.method,
      url: request.url,
      host: request.headers.get('host') ?? undefined,
      origin: request.headers.get('origin') ?? undefined,
      contentType: request.headers.get('content-type') ?? undefined,
      readBody: () => readBody(request),
    });
    return respond(status, mark);
  };
  return { GET: route, POST: route };
};

// 모듈을 불러오기만 해서는 아무것도 만들지 않게, 처음 요청이 올 때 만든다.
let defaultRoute: RdxReportRoute | undefined;
const getDefaultRoute = (): RdxReportRoute => (defaultRoute ??= createRdxReportRoute());

/** `export { GET, POST } from 'react-data-xray/next'` 로 쓰는 기본 처리기. 보고서는 `next dev` 를 실행한 폴더의 `.rdx` 에 쓴다. */
export const GET: RouteHandler = (request) => getDefaultRoute().GET(request);
export const POST: RouteHandler = (request) => getDefaultRoute().POST(request);
