import type { IncomingMessage, ServerResponse } from 'node:http';

import { rdxReportMiddleware, type RdxReportOptions } from './middleware.js';

// vite 를 의존성으로 두지 않으려고 쓰는 부분만 적는다.
interface ViteDevServer {
  config?: { server?: { allowedHosts?: readonly string[] | true } };
  middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
}

/**
 * dev 서버에서 rdx 보고서를 `.rdx/report.json` 에 쓴다.
 * `vite.config.ts`: `plugins: [react(), rdx()]`
 * 위치는 dev 명령을 실행한 폴더(보통 package.json 이 있는 곳) 기준이다. Vite 의 root 를 src 로 두는 앱이 있어 root 를 쓰지 않는다.
 */
export const rdx = (options: RdxReportOptions = {}) => ({
  name: 'react-data-xray',
  apply: 'serve' as const,
  configureServer(server: ViteDevServer) {
    // Vite 에 이미 지정한 allowedHosts 를 그대로 쓴다(LAN IP·컨테이너 이름으로 접속하는 경우).
    const allowedHosts = options.allowedHosts ?? server.config?.server?.allowedHosts;
    server.middlewares.use(rdxReportMiddleware(process.cwd(), { ...options, allowedHosts }));
  },
});
