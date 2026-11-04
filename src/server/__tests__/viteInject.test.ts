// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { rdx } from '../vite.js';

afterEach(() => vi.unstubAllEnvs());

describe('Vite 플러그인 inject (#79)', () => {
  it('inject_tag: inject 면 head 앞쪽에 rdx 를 불러오는 모듈 스크립트를 넣는다', () => {
    vi.stubEnv('VITEST', '');
    expect(rdx({ inject: true }).transformIndexHtml?.handler('', { path: '/index.html' })).toEqual([
      { tag: 'script', attrs: { type: 'module' }, children: "import 'react-data-xray';", injectTo: 'head-prepend' },
    ]);
  });

  it('inject_default_off: 기본값은 HTML 훅 자체를 달지 않는다(Vite 3 이하도 전과 같은 플러그인)', () => {
    expect(rdx()).not.toHaveProperty('transformIndexHtml');
    expect(rdx({ dir: '.out', inject: false })).not.toHaveProperty('transformIndexHtml');
  });

  it('inject_order: 다른 플러그인보다 먼저 돌고 dev 서버에만 붙는다', () => {
    const plugin = rdx({ inject: true });
    expect(plugin.transformIndexHtml?.order).toBe('pre');
    // production 빌드에는 플러그인 자체가 붙지 않아 HTML 에 들어가지 않는다.
    expect(plugin.apply).toBe('serve');
  });

  it('inject_skips: Vitest 와 Storybook 의 iframe.html 에는 넣지 않는다', () => {
    const { handler } = rdx({ inject: true }).transformIndexHtml!;
    vi.stubEnv('VITEST', 'true');
    expect(handler('', { path: '/index.html' })).toEqual([]);
    vi.stubEnv('VITEST', '');
    expect(handler('', { path: '/iframe.html' })).toEqual([]);
    expect(handler('', { path: '/iframe.html?id=button--primary' })).toEqual([]);
    expect(handler('', { path: '/admin/index.html' })).toHaveLength(1);
  });

  it('inject_keeps_report: inject 와 함께 써도 보고서 미들웨어는 그대로 붙는다', () => {
    const handlers: Array<(req: never, res: never, next: () => void) => void> = [];
    rdx({ inject: true, allowedHosts: true }).configureServer({ middlewares: { use: (h) => handlers.push(h) } });
    expect(handlers).toHaveLength(1);
    let passed = false;
    handlers[0]({ url: '/other', method: 'GET', headers: {} } as never, {} as never, () => (passed = true));
    expect(passed).toBe(true);
  });
});

describe('Vite 의 실제 HTML 처리 (#79)', () => {
  let root = '';
  let server: ViteDevServer;
  const entry = resolve(import.meta.dirname, '../../index.ts');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rdx-vite-inject-'));
    await writeFile(join(root, 'main.js'), 'export {};\n');
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      appType: 'custom',
      plugins: [rdx({ inject: true })],
      // 픽스처에서 패키지를 설치하지 않고 소스를 가리킨다.
      resolve: { alias: { 'react-data-xray': entry } },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, ws: false },
    });
  });
  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('inject_real_vite: 넣은 스크립트는 진입 스크립트보다 앞이고, 맨 이름 import 가 불러올 수 있는 경로로 바뀐다', async () => {
    vi.stubEnv('VITEST', '');
    const html = await server.transformIndexHtml(
      '/index.html',
      '<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
    );
    const proxy = /<script type="module" src="([^"]*\/index\.html\?html-proxy[^"]*)"><\/script>/.exec(html);
    expect(proxy).not.toBeNull();
    expect(html.indexOf(proxy![0])).toBeLessThan(html.indexOf('src="/main.js"'));
    // 맨 이름이 HTML 에 그대로 남으면 브라우저가 불러오지 못한다.
    expect(html).not.toContain("import 'react-data-xray'");

    // Vite 8 은 가상 모듈 표기(/@id/__x00__)를 붙인다. 브라우저 요청은 미들웨어가 벗기므로 같은 일을 한다.
    const url = proxy![1].replaceAll('&amp;', '&').replace('/@id/__x00__', '\0');
    const mod = await server.transformRequest(url);
    const imported = /import\s+["']([^"']+)["']/.exec(mod?.code ?? '')?.[1];
    expect(imported).toBeDefined();
    expect(imported).not.toBe('react-data-xray');
    expect(imported).toContain('src/index.ts');
  });
});
