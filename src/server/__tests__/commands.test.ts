// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  COMMAND_TTL_MS,
  createCommand,
  finishCommand,
  getCommand,
  liveTabs,
  seeTab,
  storeFor,
  TAB_LIVE_MS,
  takeCommands,
} from '../commandQueue.js';
import { rdxReportMiddleware } from '../middleware.js';
import { createRdxReportRoute } from '../next.js';

let root = '';
let server: Server;
let base = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-cmd-'));
  const handle = rdxReportMiddleware(root);
  server = createServer((req, res) => handle(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const a = server.address();
  base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const json = { 'content-type': 'application/json' };
/** CLI 처럼: Origin 없이, Host 는 주소에서 */
const command = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/__rdx/command`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
/** 브라우저의 받아 가기(보고서가 그대로인 주기) */
const poll = (tab: string) => fetch(`${base}/__rdx/report?tab=${tab}&path=%2Fusers&title=Users`);
const result = (id: string, tab: string, body: unknown) =>
  fetch(`${base}/__rdx/report?command=${id}&tab=${tab}`, {
    method: 'POST',
    headers: { ...json, origin: base },
    body: JSON.stringify(body),
  });

/** fetch 는 Host 를 바꾸지 못한다. DNS 리바인딩처럼 다른 Host 로 보낸다 */
const rebound = (method: string, path: string, body?: string) =>
  new Promise<{ status: number; mark: string | undefined }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { host: 'evil.example', ...json } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, mark: res.headers['x-rdx-report'] as string | undefined });
    });
    req.on('error', reject);
    req.end(body);
  });

describe('명령 경로(#69)', () => {
  it('연결된 탭이 없으면 409 로 알리고, 받아 가기를 한 탭은 목록에 나온다', async () => {
    const none = await command({ op: 'reset' });
    expect([none.status, none.headers.get('x-rdx-report')]).toEqual([409, '1']);
    expect(await none.json()).toMatchObject({ error: 'no browser tab is connected' });
    expect((await poll('tabA')).status).toBe(204);
    const tabs = (await (await fetch(`${base}/__rdx/command`)).json()) as { tabs: Array<{ id: string; path: string; title: string }> };
    expect(tabs.tabs).toEqual([expect.objectContaining({ id: 'tabA', path: '/users', title: 'Users' })]);
  });

  it('맡긴 명령은 그 탭의 다음 받아 가기로 한 번만 가고, 탭이 알린 결과를 CLI 가 읽는다', async () => {
    await poll('tabA');
    const created = await command({ op: 'snapshot', name: 'before', tab: 'tabA' });
    expect(created.status).toBe(202);
    const { command: c } = (await created.json()) as { command: { id: string; status: string } };
    expect(c.status).toBe('pending');
    const picked = await poll('tabA');
    expect([picked.status, picked.headers.get('content-type')]).toEqual([200, 'application/json']);
    expect(await picked.json()).toEqual({ commands: [{ id: c.id, op: 'snapshot', name: 'before' }] });
    expect((await poll('tabA')).status).toBe(204);
    expect(await (await fetch(`${base}/__rdx/command/${c.id}`)).json()).toMatchObject({ status: 'sent', tab: 'tabA' });
    // 다른 탭이 알린 결과는 받지 않는다
    expect((await result(c.id, 'tabB', { ok: true })).status).toBe(404);
    expect((await result(c.id, 'tabA', { ok: false, error: 'boom' })).status).toBe(204);
    expect(await (await fetch(`${base}/__rdx/command/${c.id}`)).json()).toMatchObject({ status: 'failed', error: 'boom' });
    // 끝난 명령에 다시 알려도 바꾸지 않는다
    expect((await result(c.id, 'tabA', { ok: true })).status).toBe(404);
    expect((await fetch(`${base}/__rdx/command/nope`)).status).toBe(404);
  });

  it('업로드(보고서가 바뀐 주기)의 응답으로도 명령을 넘기고, 탭을 고르지 않으면 최근에 보고서가 바뀐 탭에 맡긴다', async () => {
    await poll('tabB');
    const upload = await fetch(`${base}/__rdx/report?tab=tabA&path=%2F&title=`, {
      method: 'POST',
      headers: { ...json, origin: base },
      body: '{}',
    });
    expect(upload.status).toBe(204);
    const created = (await (await command({ op: 'reset' })).json()) as {
      command: { id: string; tab: string };
      others: Array<{ id: string }>;
    };
    expect(created.command.tab).toBe('tabA');
    expect(created.others.map((t) => t.id)).toEqual(['tabB']);
    expect((await poll('tabB')).status).toBe(204);
    const next = await fetch(`${base}/__rdx/report?tab=tabA`, { method: 'POST', headers: { ...json, origin: base }, body: '{}' });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ commands: [{ id: created.command.id, op: 'reset' }] });
    // 브라우저 출처를 CLI 가 찾을 수 있게 적어 둔다
    expect(JSON.parse(await readFile(join(root, '.rdx', '.server.json'), 'utf8'))).toMatchObject({ url: base });
  });

  it('보고서 경로와 같은 Host·Origin·content-type 검사를 거치고, 잘못된 명령은 400 이다', async () => {
    await poll('tabA');
    expect((await command({ op: 'reset' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect(await rebound('POST', '/__rdx/command', '{"op":"reset"}')).toEqual({ status: 403, mark: 'forbidden-host' });
    expect(await rebound('GET', '/__rdx/command')).toEqual({ status: 403, mark: 'forbidden-host' });
    expect(await rebound('GET', '/__rdx/report?tab=tabA')).toEqual({ status: 403, mark: 'forbidden-host' });
    expect(
      (await fetch(`${base}/__rdx/command`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"op":"reset"}' })).status,
    ).toBe(403);
    for (const body of [
      { op: 'eval' },
      { op: 'snapshot' },
      { op: 'snapshot', name: '../x' },
      { op: 'snapshot', name: 'report' },
      { op: 'reset', tab: '../x' },
    ])
      expect({ body, status: (await command(body)).status }).toEqual({ body, status: 400 });
    expect((await fetch(`${base}/__rdx/command`, { method: 'POST', headers: json, body: 'not json' })).status).toBe(400);
    expect((await command({ op: 'reset', tab: 'gone' })).status).toBe(404);
    expect((await fetch(`${base}/__rdx/command/x`, { method: 'POST', headers: json, body: '{}' })).status).toBe(405);
    // 잘못된 탭 id 로는 받아 가지 않는다(핸드셰이크로 답한다)
    expect((await fetch(`${base}/__rdx/report?tab=index`)).status).toBe(204);
    expect((await fetch(`${base}/__rdx/report?command=x&tab=tabA`, { method: 'POST', headers: json, body: 'nope' })).status).toBe(400);
  });

  it('Next.js route 도 같은 명령 경로를 처리한다', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const { GET, POST } = createRdxReportRoute(root, { dir: '.rdx-next' });
      const host = { host: 'localhost:3000' };
      expect((await GET(new Request('http://localhost:3000/__rdx/report?tab=nextTab', { headers: host }))).status).toBe(204);
      const res = await POST(
        new Request('http://localhost:3000/__rdx/command', { method: 'POST', headers: { ...host, ...json }, body: '{"op":"reset"}' }),
      );
      expect([res.status, res.headers.get('content-type')]).toEqual([202, 'application/json']);
      const { command: c } = (await res.json()) as { command: { id: string } };
      const status = await GET(new Request(`http://localhost:3000/__rdx/command/${c.id}`, { headers: host }));
      expect(await status.json()).toMatchObject({ status: 'pending', tab: 'nextTab' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('명령 큐', () => {
  const tab = (id: string) => ({ id, path: '/', title: '' });

  it('TTL 안에 받아 가지 않은 명령은 expired 가 되고, 더 지나면 지운다', () => {
    const store = storeFor('/ttl');
    seeTab(store, tab('t'), false, 0);
    const created = createCommand(store, { op: 'reset' }, 0);
    if (!created.ok) throw new Error('not created');
    seeTab(store, tab('t'), false, COMMAND_TTL_MS + 1);
    expect(takeCommands(store, 't', COMMAND_TTL_MS + 1)).toEqual([]);
    expect(getCommand(store, created.command.id, COMMAND_TTL_MS + 1)).toMatchObject({ status: 'expired' });
    expect(finishCommand(store, created.command.id, 't', { ok: true }, COMMAND_TTL_MS + 2)).toBe(false);
    expect(getCommand(store, created.command.id, 2 * COMMAND_TTL_MS + 1)).toBeUndefined();
  });

  it('탭마다 따로 쌓고, 한동안 소식 없는 탭은 연결된 탭에서 뺀다', () => {
    const store = storeFor('/tabs');
    seeTab(store, tab('a'), true, 1);
    seeTab(store, tab('b'), false, 10);
    const toB = createCommand(store, { op: 'reset', tab: 'b' }, 20);
    expect(toB.ok).toBe(true);
    expect(takeCommands(store, 'a', 30)).toEqual([]);
    expect(takeCommands(store, 'b', 30)).toHaveLength(1);
    expect(liveTabs(store, 30).map((t) => t.id)).toEqual(['a', 'b']);
    expect(liveTabs(store, TAB_LIVE_MS + 5).map((t) => t.id)).toEqual(['b']);
    expect(liveTabs(store, TAB_LIVE_MS + 20)).toEqual([]);
  });

  it('한 탭에 쌓인 명령이 너무 많으면 더 받지 않는다', () => {
    const store = storeFor('/flood');
    seeTab(store, tab('t'), false, 0);
    const statuses = Array.from({ length: 21 }, () => {
      const r = createCommand(store, { op: 'reset' }, 0);
      return r.ok ? 202 : r.status;
    });
    expect(statuses.slice(-2)).toEqual([202, 429]);
  });
});
