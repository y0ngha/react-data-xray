// @vitest-environment node
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { rdxReportMiddleware } from '../middleware.js';

let root = '';
let server: Server;
let port = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-pr5-'));
  const handle = rdxReportMiddleware(root);
  server = createServer((req, res) => handle(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const a = server.address();
  port = typeof a === 'object' && a ? a.port : 0;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (query: string, body: unknown) =>
  fetch(`http://localhost:${port}/__rdx/report?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

it('PR5-6: 오래된 탭 정리와 동시에 들어온 탭의 파일은 지워지지 않는다', async () => {
  await post('tab=seed', { n: 0 });
  const indexFile = join(root, '.rdx/tabs/index.json');
  const index = JSON.parse(await readFile(indexFile, 'utf8')) as Array<{ id: string; updatedAt: number }>;
  // 옛 index 에는 'late' 가 11분 전 탭으로 남아 있다.
  index.push({ id: 'late', updatedAt: Date.now() - 11 * 60 * 1000, file: 'tabs/late.json', path: '', title: '' } as never);
  await writeFile(indexFile, JSON.stringify(index));
  await Promise.all([post('tab=other', { n: 1 }), post('tab=late', { n: 2 }), post('tab=other2', { n: 3 })]);
  expect(await readdir(join(root, '.rdx/tabs'))).toContain('late.json');
  expect((JSON.parse(await readFile(indexFile, 'utf8')) as Array<{ id: string }>).map((t) => t.id)).toContain('late');
});

it('readBody: 청크마다 지금까지 받은 전체를 다시 세지 않는다', async () => {
  const seen: number[] = [];
  const real = Buffer.byteLength;
  const spy = vi.spyOn(Buffer, 'byteLength').mockImplementation(((v: string, enc?: BufferEncoding) => {
    if (typeof v === 'string') seen.push(v.length);
    return real(v, enc);
  }) as typeof Buffer.byteLength);
  const chunk = 'x'.repeat(50_000);
  const total = await new Promise<number>((resolve, reject) => {
    const req = request(
      { port, path: '/__rdx/report', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on('error', reject);
    req.write('{"a":"');
    for (let i = 0; i < 30; i++) req.write(chunk);
    req.end('"}');
  });
  spy.mockRestore();
  expect(total).toBe(204);
  expect(Math.max(...seen)).toBeLessThan(500_000);
});
