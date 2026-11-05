// @vitest-environment node
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { REPORT_HEADER } from '../../shared/reportPath.js';
import { rdxReportMiddleware } from '../middleware.js';
import { rdx } from '../vite.js';

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** GET 한 번을 처리기에 넘기고, 처리기가 답했으면 상태와 표시 헤더, 넘겼으면 'next' */
const ask = (handle: Handler, url: string): Promise<{ status: number; mark?: string } | 'next'> =>
  new Promise((resolve) => {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => (headers[name] = value),
      end: () => resolve({ status: res.statusCode, mark: headers[REPORT_HEADER] }),
    };
    handle(
      { url, method: 'GET', headers: { host: 'localhost:5173' } } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      () => resolve('next'),
    );
  });

// #78: 브라우저의 configure({ reportPath }) 와 같은 경로로 dev 서버도 받게 한다.
describe('보고서 경로 옵션 (#78)', () => {
  it('rdxReportMiddleware 는 { path } 로 정한 경로만 받고 기본 경로는 앱에 넘긴다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rdx-path-'));
    const handle = rdxReportMiddleware(root, { path: '/app/__rdx/report' });
    expect(await ask(handle, '/app/__rdx/report')).toEqual({ status: 204, mark: '1' });
    expect(await ask(handle, '/__rdx/report')).toBe('next');
    expect(await ask(rdxReportMiddleware(root), '/__rdx/report')).toEqual({ status: 204, mark: '1' });
  });

  it('맞지 않는 경로는 시작할 때 알린다', () => {
    expect(() => rdxReportMiddleware('.', { path: 'app/__rdx' })).toThrow(/path must start with/);
    expect(() => rdxReportMiddleware('.', { path: '/a?b=1' })).toThrow(/path must start with/);
  });

  it('Vite 플러그인 rdx({ path }) 도 같은 경로로 붙인다', async () => {
    const use = vi.fn<(handler: Handler) => void>();
    rdx({ path: '/app/__rdx/report' }).configureServer({ middlewares: { use } });
    const handle = use.mock.calls[0][0];
    expect(await ask(handle, '/app/__rdx/report?x=1')).toEqual({ status: 204, mark: '1' });
    expect(await ask(handle, '/__rdx/report')).toBe('next');
  });
});
