// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
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
    expect(await asHost('192.168.0.10:5173')).toBe(403);
    expect(await asHost('192.168.0.10:5173', rdxReportMiddleware(root, { allowedHosts: ['192.168.0.10'] }))).toBe(204);
  });

  it('다른 출처, JSON 이 아닌 본문, 다른 경로는 받지 않는다', async () => {
    expect((await post('{}', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post('not json')).status).toBe(400);
    expect((await fetch(`${base}/other`, { method: 'POST' })).status).toBe(404);
  });

  it('Vite 플러그인은 dev 서버에만 미들웨어를 붙인다', () => {
    const used: unknown[] = [];
    const plugin = rdx();
    plugin.configureServer({ middlewares: { use: (h) => used.push(h) } });
    expect(plugin.apply).toBe('serve');
    expect(used).toHaveLength(1);
  });
});
