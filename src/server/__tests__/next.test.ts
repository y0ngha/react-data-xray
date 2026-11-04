// @vitest-environment node
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRdxReportRoute, GET, POST } from '../next.js';

let root = '';
const base = 'http://localhost:3000';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-next-'));
});
beforeEach(() => vi.stubEnv('NODE_ENV', 'development'));
afterEach(() => vi.unstubAllEnvs());

/** Next 가 route handler 에 넘기는 것과 같은 Web Request. Host 는 브라우저처럼 직접 단다(Request 는 URL 에서 채우지 않는다). */
const request = (path: string, init: RequestInit & { host?: string } = {}) => {
  const { host = 'localhost:3000', headers, ...rest } = init;
  return new Request(`${base}${path}`, { ...rest, headers: { host, ...(headers as Record<string, string>) } });
};
const postJson = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body });

describe('Next.js route handler', () => {
  it('GET 으로 물으면 미들웨어와 같은 표시 헤더로 답한다', async () => {
    const { GET: get } = createRdxReportRoute(root);
    const res = await get(request('/__rdx/report'));
    expect([res.status, res.headers.get('x-rdx-report')]).toEqual([204, '1']);
  });

  it('POST 는 report.json·snapshot·탭 파일을 미들웨어와 같은 자리에 쓰고 폴더를 git 에서 뺀다', async () => {
    const { POST: post } = createRdxReportRoute(root);
    expect((await post(postJson('/__rdx/report', '{"requests":{"total":1}}'))).status).toBe(204);
    expect(JSON.parse(await readFile(join(root, '.rdx/report.json'), 'utf8'))).toEqual({ requests: { total: 1 } });
    expect(await readFile(join(root, '.rdx/.gitignore'), 'utf8')).toBe('*\n');

    expect((await post(postJson('/__rdx/report?name=before-fix', '{"scenario":1}'))).status).toBe(204);
    expect(JSON.parse(await readFile(join(root, '.rdx/before-fix.json'), 'utf8'))).toEqual({ scenario: 1 });
    expect((await post(postJson('/__rdx/report?name=..%2Fescape', '{}'))).status).toBe(400);

    expect((await post(postJson('/__rdx/report?tab=t1&path=%2Fa&title=A', '{"x":1}'))).status).toBe(204);
    expect(JSON.parse(await readFile(join(root, '.rdx/tabs/t1.json'), 'utf8'))).toMatchObject({ tab: { id: 't1', path: '/a' }, x: 1 });
    expect((await readdir(join(root, '.rdx'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('Host·Origin 검사가 미들웨어와 같다', async () => {
    const { GET: get, POST: post } = createRdxReportRoute(root);
    const blocked = await get(request('/__rdx/report', { host: 'evil.example:3000' }));
    expect([blocked.status, blocked.headers.get('x-rdx-report')]).toEqual([403, 'forbidden-host']);
    expect((await get(request('/__rdx/report', { host: '192.168.0.10:3000' }))).status).toBe(204);
    const allowed = createRdxReportRoute(root, { allowedHosts: ['devbox.internal'] });
    expect((await allowed.GET(request('/__rdx/report', { host: 'devbox.internal:3000' }))).status).toBe(204);
    // 다른 출처(포트만 달라도), JSON 이 아닌 본문, 깨진 JSON
    expect((await post(postJson('/__rdx/report', '{}', { origin: 'http://localhost:5173' }))).status).toBe(403);
    expect((await post(postJson('/__rdx/report', '{}', { 'content-type': 'text/plain' }))).status).toBe(403);
    expect((await post(postJson('/__rdx/report', 'not json'))).status).toBe(400);
  });

  it('상한을 넘는 본문은 받지 않는다', async () => {
    const { POST: post } = createRdxReportRoute(root);
    const big = `{"x":"${'a'.repeat(5 * 1024 * 1024)}"}`;
    expect((await post(postJson('/__rdx/report?name=big', big))).status).toBe(400);
    await expect(readFile(join(root, '.rdx/big.json'), 'utf8')).rejects.toThrow('ENOENT');
  });

  it('development 가 아니면(next start, 테스트) 404 로 답하고 표시도, 파일도 남기지 않는다', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { GET: get, POST: post } = createRdxReportRoute(root);
    const res = await get(request('/__rdx/report'));
    expect([res.status, res.headers.get('x-rdx-report')]).toEqual([404, null]);
    expect((await post(postJson('/__rdx/report?name=prod', '{}'))).status).toBe(404);
    await expect(readFile(join(root, '.rdx/prod.json'), 'utf8')).rejects.toThrow('ENOENT');
  });

  it('기본 GET·POST 는 실행한 폴더 기준으로 처음 요청 때 만든다', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    expect((await GET(request('/__rdx/report'))).headers.get('x-rdx-report')).toBe('1');
    expect((await POST(postJson('/__rdx/report?name=default-route', '{"ok":true}'))).status).toBe(204);
    expect(JSON.parse(await readFile(join(root, '.rdx/default-route.json'), 'utf8'))).toEqual({ ok: true });
    vi.restoreAllMocks();
  });
});
