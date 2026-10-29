// @vitest-environment node
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportFileFor } from '../../shared/reportPath.js';
import { rdxReportMiddleware } from '../middleware.js';

let root = '';
let server: Server;
let base = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-'));
  const handle = rdxReportMiddleware(root);
  server = createServer((req, res) => handle(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const a = server.address();
  base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (query: string, body: unknown) =>
  fetch(`${base}/__rdx/report?${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const readJson = async (f: string) => JSON.parse(await readFile(join(root, '.rdx', f), 'utf8'));

describe('탭마다 보고서', () => {
  it('two_tabs_two_files: 두 탭이 서로 다른 파일에 쓰고 report.json 은 가장 최근 탭이다', async () => {
    expect((await post('tab=aaa&path=%2Fa&title=A', { n: 1 })).status).toBe(204);
    expect((await post('tab=bbb&path=%2Fb&title=B', { n: 2 })).status).toBe(204);
    expect((await readJson('tabs/aaa.json')).n).toBe(1);
    const b = await readJson('tabs/bbb.json');
    expect(b).toMatchObject({ n: 2, tab: { id: 'bbb', path: '/b', title: 'B' } });
    expect(typeof b.tab.updatedAt).toBe('number');
    expect((await readJson('report.json')).n).toBe(2);
    // 열려 있다는 알림만은 report.json 을 바꾸지 않는다.
    await post('tab=aaa&idle=1', { n: 1 });
    expect((await readJson('report.json')).n).toBe(2);
  });

  it('tabs_index_file: 열린 탭 목록이 있다', async () => {
    const index = await readJson('tabs/index.json');
    expect(index.map((t: { id: string }) => t.id).sort()).toEqual(['aaa', 'bbb']);
    expect(index[0]).toMatchObject({ file: reportFileFor(index[0].id), path: expect.any(String) });
  });

  it('stale_tab_cleanup: 오래 갱신 없는 탭 파일은 다음 보고서 때 지운다', async () => {
    const dir = join(root, '.rdx/tabs');
    const index = await readJson('tabs/index.json');
    index.find((t: { id: string }) => t.id === 'aaa').updatedAt = Date.now() - 11 * 60 * 1000;
    await writeFile(join(dir, 'index.json'), JSON.stringify(index));
    await utimes(join(dir, 'aaa.json'), new Date(), new Date());
    await post('tab=ccc', { n: 3 });
    expect((await readdir(dir)).sort()).toEqual(['bbb.json', 'ccc.json', 'index.json']);
    expect((await readJson('tabs/index.json')).map((t: { id: string }) => t.id).sort()).toEqual(['bbb', 'ccc']);
  });

  it('경로를 만드는 탭 id 와 index 는 받지 않는다', async () => {
    expect((await post('tab=..%2Fx', {})).status).toBe(400);
    expect((await post('tab=index', {})).status).toBe(400);
    expect(() => reportFileFor('../x')).toThrow('invalid tab id');
  });
});
