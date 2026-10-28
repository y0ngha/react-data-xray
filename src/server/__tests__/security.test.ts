// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rdxReportMiddleware } from '../middleware.js';

let root = '';
let server: Server;
let base = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-sec-'));
  const handle = rdxReportMiddleware(root);
  server = createServer((req, res) => handle(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const a = server.address();
  base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (query: string, body = '{}', headers: Record<string, string> = {}) =>
  fetch(`${base}/__rdx/report?${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('보고서 쓰기 보안', () => {
  it('path_traversal_rejected: tab/name 의 경로 글자는 400 이고 .rdx 밖에 쓰지 않는다', async () => {
    for (const q of ['tab=..%2Fx', 'tab=%2e%2e', 'tab=a%00b', 'tab=a%5Cb', 'tab=%2Fetc', 'tab=index', 'name=..%2Fx', 'name=a%00', 'name=%2fabs', 'name=.gitignore', 'name=REPORT']) {
      expect((await post(q)).status, q).toBe(400);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('cross_origin_and_non_json_rejected', async () => {
    expect((await post('tab=a', '{}', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('tab=a', '{}', { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post('tab=a', 'not json')).status).toBe(400);
  });

  it('corrupt_index_does_not_block_or_delete_outside: 조작된 index.json 이어도 저장되고 .rdx 밖은 지우지 않는다', async () => {
    const outside = join(root, 'victim.json');
    await writeFile(outside, 'keep');
    await mkdir(join(root, '.rdx', 'tabs'), { recursive: true });
    const old = Date.now() - 3_600_000;
    await writeFile(
      join(root, '.rdx', 'tabs', 'index.json'),
      JSON.stringify([null, 5, { id: '../../victim', updatedAt: old }, { id: 'index', updatedAt: old }, { id: 'x', updatedAt: 'NaN' }]),
    );
    expect((await post('tab=ok')).status).toBe(204);
    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect(JSON.parse(await readFile(join(root, '.rdx', 'tabs', 'index.json'), 'utf8')).map((t: { id: string }) => t.id)).toContain('ok');
  });

  it('too_large_rejected: 본문 상한(바이트)을 넘으면 거절한다', async () => {
    const res = await post('name=big', JSON.stringify({ s: 'é'.repeat(3_000_000) })).catch(() => null);
    expect(res === null || res.status === 400).toBe(true);
  });
});
