// @vitest-environment node
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rdxReportMiddleware } from '../middleware.js';
import { rdx } from '../vite.js';

let root = '';
let server: Server;
let base = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-'));
  const handle = rdxReportMiddleware(root);
  server = createServer((req, res) =>
    handle(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/__rdx/report`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('보고서 미들웨어', () => {
  it('같은 출처의 JSON 보고서를 .rdx/report.json 에 쓰고 폴더를 git 에서 뺀다', async () => {
    expect((await post('{"requests":{"total":1}}', { origin: base })).status).toBe(204);
    expect(JSON.parse(await readFile(join(root, '.rdx/report.json'), 'utf8'))).toEqual({ requests: { total: 1 } });
    expect(await readFile(join(root, '.rdx/.gitignore'), 'utf8')).toBe('*\n');
    // 임시 파일에 쓰고 이름을 바꾸므로 남는 임시 파일이 없다.
    expect((await readdir(join(root, '.rdx'))).sort()).toEqual(['.gitignore', 'report.json']);
  });

  it('GET 으로 물으면 미들웨어가 있다는 표시 헤더로 답한다(본문은 쓰지 않는다)', async () => {
    const res = await fetch(`${base}/__rdx/report`);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-rdx-report')).toBe('1');
  });

  it('로컬이 아닌 Host(DNS 리바인딩)는 지정하지 않았으면 받지 않는다', async () => {
    const asHost = (host: string, handle = rdxReportMiddleware(root)) =>
      new Promise<number>((resolve) => {
        const res = { statusCode: 0, setHeader: () => undefined, end: () => resolve(res.statusCode) };
        handle({ method: 'GET', url: '/__rdx/report', headers: { host } } as never, res as never, () => resolve(404));
      });
    expect(await asHost('evil.example:5173')).toBe(403);
    expect(await asHost('devbox.internal:5173')).toBe(403);
    expect(await asHost('devbox.internal:5173', rdxReportMiddleware(root, { allowedHosts: ['devbox.internal'] }))).toBe(204);
    // IP 주소는 DNS 리바인딩으로 만들 수 없는 이름이라 Vite 처럼 허용한다.
    expect(await asHost('192.168.0.10:5173')).toBe(204);
    expect(await asHost('[::1]:5173')).toBe(204);
    expect(await asHost('app.dev.example:5173', rdxReportMiddleware(root, { allowedHosts: ['.dev.example'] }))).toBe(204);
    expect(await asHost('anything:5173', rdxReportMiddleware(root, { allowedHosts: true }))).toBe(204);
  });

  it('다른 출처, JSON 이 아닌 본문, 다른 경로는 받지 않는다', async () => {
    expect((await post('{}', { origin: 'https://evil.example' })).status).toBe(403);
    // 같은 PC 의 다른 dev 서버(포트만 다름)도 다른 출처다.
    expect((await post('{}', { origin: 'http://localhost:3000' })).status).toBe(403);
    expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post('not json')).status).toBe(400);
    expect((await fetch(`${base}/other`, { method: 'POST' })).status).toBe(404);
  });

  it('HTTP/2(https dev 서버)는 Host 대신 :authority 로 판단한다', async () => {
    const status = await new Promise<number>((resolve) => {
      const res = { statusCode: 0, setHeader: () => undefined, end: () => resolve(res.statusCode) };
      rdxReportMiddleware(root)(
        { method: 'GET', url: '/__rdx/report', headers: { ':authority': 'localhost:5173' } } as never,
        res as never,
        () => resolve(404),
      );
    });
    expect(status).toBe(204);
  });

  it('Vite 플러그인은 dev 서버에만 붙고, Vite 의 allowedHosts 를 그대로 쓴다', async () => {
    const used: Array<ReturnType<typeof rdxReportMiddleware>> = [];
    const plugin = rdx();
    plugin.configureServer({ config: { server: { allowedHosts: ['devbox.internal'] } }, middlewares: { use: (h) => used.push(h) } });
    expect(plugin.apply).toBe('serve');
    const status = await new Promise<number>((resolve) => {
      const res = { statusCode: 0, setHeader: () => undefined, end: () => resolve(res.statusCode) };
      used[0]({ method: 'GET', url: '/__rdx/report', headers: { host: 'devbox.internal:5173' } } as never, res as never, () =>
        resolve(404),
      );
    });
    expect(status).toBe(204);
  });

  it('막힌 Host 에는 미들웨어가 있다는 것을 다른 표시로 알려 브라우저가 안내할 수 있게 한다', async () => {
    const headers: Record<string, string> = {};
    const status = await new Promise<number>((resolve) => {
      const r = { statusCode: 0, setHeader: (k: string, v: string) => (headers[k] = v), end: () => resolve(r.statusCode) };
      rdxReportMiddleware(root)({ method: 'GET', url: '/__rdx/report', headers: { host: 'evil.example' } } as never, r as never, () =>
        resolve(404),
      );
    });
    expect([status, headers['x-rdx-report']]).toEqual([403, 'forbidden-host']);
  });
});
