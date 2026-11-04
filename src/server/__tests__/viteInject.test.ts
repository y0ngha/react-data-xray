// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { rdx } from '../vite.js';

describe('Vite 플러그인 inject (#79)', () => {
  it('inject_tag: inject 면 head 맨 앞에 rdx 를 불러오는 모듈 스크립트를 넣는다', () => {
    const plugin = rdx({ inject: true });
    expect(plugin.transformIndexHtml.handler()).toEqual([
      { tag: 'script', attrs: { type: 'module' }, children: "import 'react-data-xray';", injectTo: 'head-prepend' },
    ]);
  });

  it('inject_default_off: 기본값은 HTML 을 바꾸지 않는다', () => {
    expect(rdx().transformIndexHtml.handler()).toEqual([]);
    expect(rdx({ dir: '.out' }).transformIndexHtml.handler()).toEqual([]);
  });

  it('inject_order: 다른 플러그인보다 먼저 돌고 dev 서버에만 붙는다', () => {
    const plugin = rdx({ inject: true });
    // post 면 Vite 가 인라인 모듈을 바꾼 뒤라 맨 이름 import 가 해석되지 않는다.
    expect(plugin.transformIndexHtml.order).toBe('pre');
    // production 빌드에는 플러그인 자체가 붙지 않아 HTML 에 들어가지 않는다.
    expect(plugin.apply).toBe('serve');
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
