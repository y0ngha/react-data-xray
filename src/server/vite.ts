import type { IncomingMessage, ServerResponse } from 'node:http';

import { rdxReportMiddleware, type RdxReportOptions } from './middleware.js';

// vite 를 의존성으로 두지 않으려고 쓰는 부분만 적는다.
interface ViteDevServer {
  config?: { server?: { allowedHosts?: readonly string[] | true } };
  middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
}

interface HtmlTag {
  tag: string;
  attrs?: Record<string, string>;
  children?: string;
  injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend';
}

interface HtmlContext {
  path?: string;
}

export interface RdxViteOptions extends RdxReportOptions {
  /**
   * true 면 Vite dev 서버가 내보내는 index.html 에 `import 'react-data-xray'` 모듈 스크립트를 넣는다.
   * 앱의 진입 모듈보다 먼저 평가되므로(Vite 의 client·react-refresh 프리앰블 다음) 진입 파일에서 import 하지 않아도
   * 첫 요청·렌더부터 잡힌다. Vite 4 이상이 필요하다. 기본은 false: 앱의 HTML 을 말없이 바꾸지 않는다.
   * Vitest 와 Storybook(`iframe.html`)이 같은 설정을 읽어도 그곳에는 넣지 않는다.
   */
  inject?: boolean;
}

/**
 * 진입 스크립트보다 먼저 평가될 모듈 스크립트. 맨 이름은 dev 서버의 import 분석이 사전 번들 경로로 바꾼다.
 * 진입 파일의 `import { RdxDevtools } from 'react-data-xray'` 와 같은 URL 이 되므로 모듈은 한 번만 평가된다(설치도 한 번).
 * head-prepend 지만 Vite 는 자신의 client·프리앰블을 그보다 앞에 둔다. 다른 플러그인이 head 앞에 넣은 스크립트도 먼저 돌 수 있다.
 */
const INJECT_TAG: HtmlTag = {
  tag: 'script',
  attrs: { type: 'module' },
  children: "import 'react-data-xray';",
  injectTo: 'head-prepend',
};

// Storybook 의 Vite 빌더가 스토리를 그리는 HTML. 스토리마다 rdx 가 설치되면 의도와 다르다.
const STORYBOOK_HTML = /(^|\/)iframe\.html$/;

const shouldInject = (ctx: HtmlContext | undefined): boolean =>
  // Vitest(브라우저 모드 등)도 vite.config 를 읽는다. 테스트 HTML 에는 넣지 않는다.
  !process.env.VITEST && !STORYBOOK_HTML.test((ctx?.path ?? '').split('?')[0]);

/**
 * dev 서버에서 rdx 보고서를 `.rdx/report.json` 에 쓴다.
 * `vite.config.ts`: `plugins: [react(), rdx()]`
 * 위치는 dev 명령을 실행한 폴더(보통 package.json 이 있는 곳) 기준이다. Vite 의 root 를 src 로 두는 앱이 있어 root 를 쓰지 않는다.
 * `rdx({ inject: true })` 면 진입 파일의 `import 'react-data-xray'` 없이 `<RdxDevtools />` 만 두면 된다.
 */
export const rdx = ({ inject = false, ...options }: RdxViteOptions = {}) => ({
  name: 'react-data-xray',
  // dev 서버에만 붙는다: production 빌드의 HTML 에는 넣지 않는다.
  apply: 'serve' as const,
  // 켠 경우에만 훅을 단다. 끈 사용자는 `{ order, handler }` 형식을 모르는 Vite 3 이하에서도 전과 같은 플러그인을 쓴다.
  ...(inject && {
    transformIndexHtml: {
      // 일반·post 훅은 Vite 가 인라인 모듈을 html-proxy 로 바꾸고 맨 이름 import 를 해석한 뒤라 브라우저가 맨 이름을 받는다.
      order: 'pre' as const,
      handler: (_html: string, ctx?: HtmlContext): HtmlTag[] => (shouldInject(ctx) ? [INJECT_TAG] : []),
    },
  }),
  configureServer(server: ViteDevServer) {
    // Vite 에 이미 지정한 allowedHosts 를 그대로 쓴다(LAN IP·컨테이너 이름으로 접속하는 경우).
    const allowedHosts = options.allowedHosts ?? server.config?.server?.allowedHosts;
    server.middlewares.use(rdxReportMiddleware(process.cwd(), { ...options, allowedHosts }));
  },
});
