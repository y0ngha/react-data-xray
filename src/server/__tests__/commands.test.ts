// @vitest-environment node
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../../cli/main.js';
import { commandPathFor } from '../../shared/reportPath.js';

import {
  cancelCommand,
  createCommand,
  DEFAULT_COMMAND_TIMEOUT_MS,
  finishCommand,
  getCommand,
  isCommandLive,
  liveTabs,
  MAX_TABS,
  RECENT_FOCUS_MS,
  seeTab,
  storeFor,
  TAB_LIVE_MS,
  takeCommands,
  type TabNotice,
} from '../commandQueue.js';
import { rdxReportMiddleware } from '../middleware.js';
import { createRdxReportRoute } from '../next.js';
import { createReportHandler, type ReportRequest } from '../reportHandler.js';

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
const serverFile = async () => JSON.parse(await readFile(join(root, '.rdx', '.server.json'), 'utf8')) as { token: string; url?: string };
/** CLI 처럼: Origin 없이, Host 는 주소에서, 토큰은 .server.json 에서 */
const cli = async (path: string, init: RequestInit = {}) => {
  // 토큰 파일이 없으면 첫 요청이 만든다
  await fetch(`${base}/__rdx/command`);
  const { token } = await serverFile();
  return fetch(`${base}${path}`, { ...init, headers: { 'x-rdx-token': token, ...(init.headers as Record<string, string>) } });
};
const command = (body: unknown, headers: Record<string, string> = {}) =>
  cli('/__rdx/command', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
const status = async (id: string) => (await (await cli(`/__rdx/command/${id}`)).json()) as Record<string, unknown>;
/** 브라우저의 받아 가기(보고서가 그대로인 주기) */
const poll = (tab: string, extra = 'visible=1&focusedAgo=0') =>
  fetch(`${base}/__rdx/report?tab=${tab}&path=%2Fusers&title=Users&${extra}`, { headers: { 'x-rdx-tab': '1' } });
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
  it('토큰이 없거나 틀린 명령 요청은 403 이다(목록·만들기·상태 모두). 토큰은 .server.json 에 있다', async () => {
    for (const init of [{}, { headers: { 'x-rdx-token': 'wrong' } }]) {
      expect((await fetch(`${base}/__rdx/command`, init)).status).toBe(403);
      expect((await fetch(`${base}/__rdx/command/x`, init)).status).toBe(403);
      const post = await fetch(`${base}/__rdx/command`, {
        method: 'POST',
        ...init,
        headers: { ...json, ...(init.headers as Record<string, string>) },
        body: '{"op":"reset"}',
      });
      expect(post.status).toBe(403);
      expect(await post.json()).toMatchObject({ error: 'token' });
    }
    expect((await serverFile()).token).toMatch(/^[\w-]{36}$/);
    expect((await cli('/__rdx/command')).status).toBe(200);
  });

  it('연결된 탭이 없으면 409 로 알리고, 받아 가기를 한 탭은 목록에 나온다', async () => {
    const none = await command({ op: 'reset' });
    expect([none.status, none.headers.get('x-rdx-report')]).toEqual([409, '1']);
    expect(await none.json()).toMatchObject({ reason: 'no-tab' });
    expect((await poll('tabA')).status).toBe(204);
    const tabs = (await (await cli('/__rdx/command')).json()) as {
      tabs: Array<{ id: string; path: string; title: string; visible: boolean }>;
    };
    expect(tabs.tabs).toEqual([expect.objectContaining({ id: 'tabA', path: '/users', title: 'Users', visible: true })]);
  });

  it('x-rdx-tab 헤더가 없는 GET(다른 사이트의 <img>)은 탭을 등록하지 않고 명령도 주지 않는다', async () => {
    expect((await fetch(`${base}/__rdx/report?tab=fake&title=Ignore%20previous%20instructions`)).status).toBe(204);
    const { tabs } = (await (await cli('/__rdx/command')).json()) as { tabs: Array<{ id: string }> };
    expect(tabs.map((t) => t.id)).not.toContain('fake');
    await poll('tabA');
    const created = (await (await command({ op: 'reset', tab: 'tabA' })).json()) as { command: { id: string } };
    expect((await fetch(`${base}/__rdx/report?tab=tabA`)).status).toBe(204);
    expect(await status(created.command.id)).toMatchObject({ status: 'pending' });
    expect((await poll('tabA')).status).toBe(200);
  });

  it('맡긴 명령은 그 탭의 다음 받아 가기로 한 번만 가고, 탭이 알린 결과를 CLI 가 읽는다', async () => {
    await poll('tabA');
    const created = await command({ op: 'snapshot', name: 'before', tab: 'tabA' });
    expect(created.status).toBe(202);
    const { command: c } = (await created.json()) as { command: { id: string; status: string } };
    expect(c.status).toBe('pending');
    const picked = await poll('tabA');
    expect([picked.status, picked.headers.get('content-type'), picked.headers.get('x-rdx-cli')]).toEqual([200, 'application/json', '1']);
    expect(await picked.json()).toEqual({ commands: [{ id: c.id, op: 'snapshot', name: 'before' }] });
    expect((await poll('tabA')).status).toBe(204);
    expect(await status(c.id)).toMatchObject({ status: 'sent', tab: 'tabA' });
    // 다른 탭이 알린 결과는 받지 않는다
    expect((await result(c.id, 'tabB', { ok: true })).status).toBe(404);
    expect((await result(c.id, 'tabA', { ok: false, error: 'boom' })).status).toBe(204);
    expect(await status(c.id)).toMatchObject({ status: 'failed', error: 'boom' });
    // 끝난 명령에 다시 알려도 바꾸지 않는다
    expect((await result(c.id, 'tabA', { ok: true })).status).toBe(404);
    expect((await cli('/__rdx/command/nope')).status).toBe(404);
  });

  it('업로드(보고서가 바뀐 주기)의 응답으로도 명령을 넘기고, dev 서버 자신의 주소를 .server.json 에 적는다', async () => {
    await poll('tabA');
    const created = (await (await command({ op: 'reset', tab: 'tabA' })).json()) as { command: { id: string } };
    const next = await fetch(`${base}/__rdx/report?tab=tabA`, { method: 'POST', headers: { ...json, origin: base }, body: '{}' });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ commands: [{ id: created.command.id, op: 'reset' }] });
    expect(await serverFile()).toMatchObject({ url: base });
  });

  it('보고서 경로와 같은 Host·Origin·content-type 검사를 거치고, 잘못된 명령은 400 이다', async () => {
    await poll('tabA');
    expect((await command({ op: 'reset' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect(await rebound('POST', '/__rdx/command', '{"op":"reset"}')).toEqual({ status: 403, mark: 'forbidden-host' });
    expect(await rebound('GET', '/__rdx/command')).toEqual({ status: 403, mark: 'forbidden-host' });
    expect(await rebound('GET', '/__rdx/report?tab=tabA')).toEqual({ status: 403, mark: 'forbidden-host' });
    expect(
      (await cli('/__rdx/command', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"op":"reset"}' })).status,
    ).toBe(403);
    for (const body of [
      { op: 'eval' },
      { op: 'snapshot' },
      { op: 'snapshot', name: '../x' },
      { op: 'snapshot', name: 'report' },
      { op: 'reset', tab: '../x' },
      { op: 'reset', tab: 'index' },
    ])
      expect({ body, status: (await command(body)).status }).toEqual({ body, status: 400 });
    expect((await cli('/__rdx/command', { method: 'POST', headers: json, body: 'not json' })).status).toBe(400);
    expect((await command({ op: 'reset', tab: 'gone' })).status).toBe(404);
    expect((await cli('/__rdx/command/x', { method: 'POST', headers: json, body: '{}' })).status).toBe(405);
    // 잘못된 탭 id 로는 받아 가지 않는다(핸드셰이크로 답한다)
    expect((await poll('index')).status).toBe(204);
    expect((await fetch(`${base}/__rdx/report?command=x&tab=tabA`, { method: 'POST', headers: json, body: 'nope' })).status).toBe(400);
  });

  it('Next.js route 도 같은 명령 경로를 처리한다', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const { GET, POST } = createRdxReportRoute(root, { dir: '.rdx-next' });
      const host = { host: 'localhost:3000' };
      expect((await GET(new Request('http://localhost:3000/__rdx/command', { headers: host }))).status).toBe(403);
      const { token } = JSON.parse(await readFile(join(root, '.rdx-next', '.server.json'), 'utf8')) as { token: string };
      const auth = { ...host, 'x-rdx-token': token };
      expect(
        (await GET(new Request('http://localhost:3000/__rdx/report?tab=nextTab', { headers: { ...host, 'x-rdx-tab': '1' } }))).status,
      ).toBe(204);
      const res = await POST(
        new Request('http://localhost:3000/__rdx/command', { method: 'POST', headers: { ...auth, ...json }, body: '{"op":"reset"}' }),
      );
      expect([res.status, res.headers.get('content-type')]).toEqual([202, 'application/json']);
      const { command: c } = (await res.json()) as { command: { id: string } };
      const s = await GET(new Request(`http://localhost:3000/__rdx/command/${c.id}`, { headers: auth }));
      expect(await s.json()).toMatchObject({ status: 'pending', tab: 'nextTab' });
      // CLI 가 쓰는 중이라 탭에 5초 주기로 받아 가라고 알린다
      const picked = await GET(new Request('http://localhost:3000/__rdx/report?tab=nextTab', { headers: { ...host, 'x-rdx-tab': '1' } }));
      expect(picked.headers.get('x-rdx-cli')).toBe('1');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('명령 큐', () => {
  const tab = (id: string, extra: Partial<TabNotice> = {}): TabNotice => ({ id, path: '/', title: '', visible: true, ...extra });

  it('받아 가지 않은 명령은 CLI 의 시간 제한이 되는 그때 expired 가 되어, 늦게 받아 가 실행되지 않는다', () => {
    const store = storeFor('/ttl');
    seeTab(store, tab('t'), 0);
    const created = createCommand(store, { op: 'reset', timeoutMs: 1000 }, 0);
    if (!created.ok) throw new Error('not created');
    expect(getCommand(store, created.command.id, 999)).toMatchObject({ status: 'pending' });
    seeTab(store, tab('t'), 1000);
    expect(takeCommands(store, 't', 1000)).toEqual([]);
    expect(getCommand(store, created.command.id, 1000)).toMatchObject({ status: 'expired', error: expect.stringContaining('did not run') });
    expect(finishCommand(store, created.command.id, 't', { ok: true }, 1001)).toBe(false);
    // 시간 제한을 주지 않으면 기본값
    const legacy = createCommand(store, { op: 'reset' }, 0);
    expect(legacy.ok && legacy.command.expiresAt).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });

  it('받아 간 명령도 CLI 의 시간 제한이 지나면(탭이 계속 알려도) 실행됐을 수 있다며 expired 다. 탭이 끊기면 그 전에도 expired 다', () => {
    const store = storeFor('/sent');
    seeTab(store, tab('t'), 0);
    const created = createCommand(store, { op: 'snapshot', name: 'slow', timeoutMs: 30_000 }, 0);
    if (!created.ok) throw new Error('not created');
    takeCommands(store, 't', 10);
    expect(isCommandLive(store, created.command.id, 't', 20)).toBe(true);
    expect(isCommandLive(store, created.command.id, 'other', 20)).toBe(false);
    for (let now = 5000; now <= 30_000; now += 5000) seeTab(store, tab('t'), now);
    expect(getCommand(store, created.command.id, 30_000)).toMatchObject({
      status: 'expired',
      error: expect.stringContaining('may have run'),
    });
    expect(isCommandLive(store, created.command.id, 't', 30_000)).toBe(false);
    // 늦게 온 결과는 받지 않는다
    expect(finishCommand(store, created.command.id, 't', { ok: true }, 30_001)).toBe(false);
    const lost = createCommand(store, { op: 'reset', timeoutMs: 600_000 }, 30_002);
    if (!lost.ok) throw new Error('not created');
    takeCommands(store, 't', 30_003);
    expect(getCommand(store, lost.command.id, 30_000 + TAB_LIVE_MS + 1)).toMatchObject({ status: 'expired' });
  });

  it('CLI 가 그만두면(DELETE) 아직 받아 가지 않은 명령은 실행하지 않고, 받아 간 명령은 실행됐을 수 있다고 남긴다', () => {
    const store = storeFor('/cancel');
    seeTab(store, tab('t'), 0);
    const waiting = createCommand(store, { op: 'reset' }, 0);
    if (!waiting.ok) throw new Error('not created');
    expect(cancelCommand(store, waiting.command.id, 1)).toMatchObject({ status: 'expired', error: expect.stringContaining('did not run') });
    expect(takeCommands(store, 't', 2)).toEqual([]);
    const sent = createCommand(store, { op: 'reset' }, 3);
    if (!sent.ok) throw new Error('not created');
    takeCommands(store, 't', 4);
    expect(cancelCommand(store, sent.command.id, 5)).toMatchObject({ status: 'expired', error: expect.stringContaining('may have run') });
    expect(isCommandLive(store, sent.command.id, 't', 6)).toBe(false);
    expect(cancelCommand(store, 'nope', 7)).toBeUndefined();
  });

  it('가장 느린 받아 가기(가려진 탭, 1분에 한 번)보다 오래 연결된 탭으로 본다', () => {
    expect(TAB_LIVE_MS).toBeGreaterThan(2 * 60_000);
  });

  it('탭을 고르지 않으면 보이는 탭 중 최근에 포커스를 받은 탭, 그런 탭이 없으면 고르지 않는다', () => {
    const now = 10 * RECENT_FOCUS_MS;
    const pick = (tabs: TabNotice[]) => {
      const store = storeFor(`/pick-${Math.random()}`);
      tabs.forEach((t) => seeTab(store, t, now));
      const r = createCommand(store, { op: 'reset' }, now);
      return r.ok ? r.command.tab : r.reason;
    };
    expect(pick([tab('only', { visible: false })])).toBe('only');
    expect(pick([tab('shown'), tab('hidden', { visible: false, focusedAgo: 0 })])).toBe('shown');
    expect(pick([tab('old', { focusedAgo: 60_000 }), tab('new', { focusedAgo: 1000 })])).toBe('new');
    expect(pick([tab('a', { focusedAgo: RECENT_FOCUS_MS + 1 }), tab('b')])).toBe('ambiguous');
    expect(pick([tab('a', { visible: false }), tab('b', { visible: false, focusedAgo: 5 })])).toBe('b');
  });

  it('탭마다 따로 쌓고, 한동안 소식 없는 탭은 빼며, 기억하는 탭 수에 상한이 있다', () => {
    const store = storeFor('/tabs');
    seeTab(store, tab('a'), 1);
    seeTab(store, tab('b'), 10);
    expect(createCommand(store, { op: 'reset', tab: 'b' }, 20).ok).toBe(true);
    expect(takeCommands(store, 'a', 30)).toEqual([]);
    expect(takeCommands(store, 'b', 30)).toHaveLength(1);
    expect(liveTabs(store, TAB_LIVE_MS + 5).map((t) => t.id)).toEqual(['b']);
    expect(liveTabs(store, TAB_LIVE_MS + 20)).toEqual([]);
    for (let i = 0; i < MAX_TABS + 10; i++) seeTab(store, tab(`t${i}`), 100_000 + i);
    const ids = liveTabs(store, 100_000 + MAX_TABS + 10).map((t) => t.id);
    expect(ids).toHaveLength(MAX_TABS);
    expect(ids).not.toContain('t0');
    expect(ids).toContain(`t${MAX_TABS + 9}`);
  });

  it('한 탭에 쌓인 명령이 너무 많으면 더 받지 않는다', () => {
    const store = storeFor('/flood');
    seeTab(store, tab('t'), 0);
    const statuses = Array.from({ length: 21 }, () => {
      const r = createCommand(store, { op: 'reset' }, 0);
      return r.ok ? 202 : r.status;
    });
    expect(statuses.slice(-2)).toEqual([202, 429]);
  });
});

describe('명령 경로 보안(#69 2차)', () => {
  const tabHeaders = { 'x-rdx-tab': '1' };
  const make = async (options: Parameters<typeof createReportHandler>[1] = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'rdx-sec2-'));
    return { dir, handle: createReportHandler(dir, options) };
  };
  const req = (over: Partial<ReportRequest>): ReportRequest => ({
    method: 'GET',
    url: '/__rdx/report',
    host: 'localhost:5173',
    origin: undefined,
    contentType: undefined,
    body: null,
    remoteAddress: '127.0.0.1',
    serverUrl: 'http://localhost:5173',
    ...over,
  });
  const body = (text: string) => new Response(text).body;
  const savedFile = async (dir: string) =>
    JSON.parse(await readFile(join(dir, '.rdx', '.server.json'), 'utf8')) as { url?: string; token: string };

  it('LAN 의 기기가 자기 Host·Origin 으로 보내도 .server.json 의 주소는 dev 서버 자신의 주소다(토큰을 다른 기기로 보내지 않게)', async () => {
    const { dir, handle } = await make();
    const lan = { host: '10.0.0.9:5173', origin: 'http://10.0.0.9:5173', remoteAddress: '10.0.0.9', contentType: 'application/json' };
    expect((await handle(req({ ...lan, method: 'POST', url: '/__rdx/report?tab=lanTab', body: body('{}') }))).status).toBe(204);
    expect((await savedFile(dir)).url).toBe('http://localhost:5173');
    // 주소를 모르는 요청(Next)은 지난번 주소를 지우지 않는다
    await handle(
      req({ method: 'POST', url: '/__rdx/report?tab=t', contentType: 'application/json', body: body('{}'), serverUrl: undefined }),
    );
    expect((await savedFile(dir)).url).toBe('http://localhost:5173');
    await rm(dir, { recursive: true, force: true });
  });

  it('dev 서버를 다시 띄워도 서버가 정한 지난 주소를 지우지 않고(새 토큰), 처음부터 주소를 모르면 url 을 쓰지 않는다', async () => {
    const { dir } = await make();
    await createReportHandler(dir)(req({ url: '/__rdx/report?tab=t', tabHeader: '1' }));
    const before = await savedFile(dir);
    expect(before.url).toBe('http://localhost:5173');
    // 재시작: 프로세스 전역 저장소가 새로 생긴다. 주소를 모르는 요청(Next)이 먼저 와도 파일의 주소를 이어 쓴다
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('react-data-xray.commandStores')];
    await createReportHandler(dir)(req({ url: '/__rdx/report?tab=t', tabHeader: '1', serverUrl: undefined }));
    const after = await savedFile(dir);
    expect(after.url).toBe('http://localhost:5173');
    expect(after.token).not.toBe(before.token);
    const fresh = await make();
    await fresh.handle(req({ url: '/__rdx/report?tab=t', tabHeader: '1', serverUrl: undefined }));
    expect((await savedFile(fresh.dir)).url).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
    await rm(fresh.dir, { recursive: true, force: true });
  });

  it('LAN 에서 온 탭은 등록하지 않고 명령도 넘기지 않으며, 명령 경로·결과도 받지 않는다. commands: lan 이면 받는다', async () => {
    const { dir, handle } = await make();
    const lan = { host: '192.168.0.2:5173', remoteAddress: '192.168.0.2' };
    expect((await handle(req({ ...lan, url: '/__rdx/report?tab=spoof', tabHeader: '1' }))).status).toBe(204);
    const { token } = await savedFile(dir).catch(async () => {
      await handle(req({ url: '/__rdx/command' }));
      return savedFile(dir);
    });
    const tabs = await handle(req({ url: '/__rdx/command', token }));
    expect(JSON.parse(tabs.body!)).toEqual({ tabs: [] });
    // LAN 에서 토큰을 가져도 명령 경로는 받지 않는다
    expect((await handle(req({ ...lan, url: '/__rdx/command', token }))).status).toBe(403);
    expect(
      (
        await handle(
          req({ ...lan, method: 'POST', url: '/__rdx/report?command=x&tab=spoof', contentType: 'application/json', body: body('{}') }),
        )
      ).status,
    ).toBe(403);
    // Host 를 localhost 로 꾸며도 소켓 주소로 본다
    expect(
      (await handle(req({ host: 'localhost:5173', remoteAddress: '192.168.0.2', url: '/__rdx/report?tab=spoof2', tabHeader: '1' }))).status,
    ).toBe(204);
    expect(JSON.parse((await handle(req({ url: '/__rdx/command', token }))).body!)).toEqual({ tabs: [] });
    const lanOk = await make({ commands: 'lan' });
    await lanOk.handle(req({ ...lan, url: '/__rdx/report?tab=lanTab', tabHeader: '1' }));
    const lanToken = (await savedFile(lanOk.dir)).token;
    const listed = JSON.parse((await lanOk.handle(req({ url: '/__rdx/command', token: lanToken }))).body!) as {
      tabs: Array<{ id: string }>;
    };
    expect(listed.tabs.map((t) => t.id)).toEqual(['lanTab']);
    await rm(dir, { recursive: true, force: true });
    await rm(lanOk.dir, { recursive: true, force: true });
  });

  it('소켓 주소가 없으면(Next) Host 이름이 루프백일 때만 탭으로 받는다', async () => {
    const { dir, handle } = await make();
    await handle(req({ url: '/__rdx/report?tab=nextLocal', tabHeader: '1', remoteAddress: undefined, serverUrl: undefined }));
    await handle(
      req({ host: '192.168.0.2:3000', url: '/__rdx/report?tab=nextLan', tabHeader: '1', remoteAddress: undefined, serverUrl: undefined }),
    );
    const { token } = await savedFile(dir);
    const listed = JSON.parse((await handle(req({ url: '/__rdx/command', token, remoteAddress: undefined }))).body!) as {
      tabs: Array<{ id: string }>;
    };
    expect(listed.tabs.map((t) => t.id)).toEqual(['nextLocal']);
    await rm(dir, { recursive: true, force: true });
  });

  it('.server.json 은 이 사용자만 읽을 수 있고(0600), 지워지면 다음 요청에 다시 쓴다', async () => {
    const { dir, handle } = await make();
    await handle(req({ url: '/__rdx/report?tab=t', tabHeader: '1' }));
    const file = join(dir, '.rdx', '.server.json');
    // Windows 에는 권한 비트가 없다
    expect(process.platform === 'win32' || ((await stat(file)).mode & 0o777) === 0o600).toBe(true);
    const { token } = await savedFile(dir);
    await unlink(file);
    await handle(req({ url: '/__rdx/report?tab=t', tabHeader: '1' }));
    expect((await savedFile(dir)).token).toBe(token);
    await rm(dir, { recursive: true, force: true });
  });

  it('DELETE /__rdx/command/<id> 로 기다리기를 그만두면 탭이 실행 직전에 물을 때 410 이다', async () => {
    const { dir, handle } = await make();
    await handle(req({ url: '/__rdx/report?tab=t', tabHeader: '1' }));
    const { token } = await savedFile(dir);
    const created = await handle(
      req({ method: 'POST', url: '/__rdx/command', token, contentType: 'application/json', body: body('{"op":"reset"}') }),
    );
    const { command: c } = JSON.parse(created.body!) as { command: { id: string } };
    await handle(req({ url: '/__rdx/report?tab=t', tabHeader: '1' }));
    expect((await handle(req({ url: `/__rdx/report?command=${c.id}&tab=t`, ...tabHeaders, tabHeader: '1' }))).status).toBe(204);
    expect((await handle(req({ method: 'DELETE', url: `/__rdx/command/${c.id}`, token }))).status).toBe(200);
    expect((await handle(req({ url: `/__rdx/report?command=${c.id}&tab=t`, tabHeader: '1' }))).status).toBe(410);
    expect((await handle(req({ method: 'DELETE', url: `/__rdx/command/${c.id}` }))).status).toBe(403);
    expect((await handle(req({ method: 'DELETE', url: '/__rdx/command/nope', token }))).status).toBe(404);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('보고서 경로를 바꾼 dev 서버(#78 와 함께)', () => {
  it('명령 경로는 보고서 경로와 같은 밑에 두고(.server.json 에 적는다), CLI 는 그 경로로 보낸다', async () => {
    expect(commandPathFor('/__rdx/report')).toBe('/__rdx/command');
    expect(commandPathFor('/api/dev/report')).toBe('/api/dev/command');
    expect(commandPathFor('/rdx-upload')).toBe('/rdx-upload/command');
    const dir = await mkdtemp(join(tmpdir(), 'rdx-path-'));
    const handle = rdxReportMiddleware(dir, { path: '/api/dev/report' });
    const custom = createServer((req, res) => handle(req, res, () => ((res.statusCode = 404), res.end())));
    await new Promise<void>((resolve) => custom.listen(0, resolve));
    const a = custom.address();
    const url = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
    try {
      // 바꾼 보고서 경로로 탭이 받아 간다. 기본 명령 경로는 이 서버의 것이 아니다
      expect((await fetch(`${url}/api/dev/report?tab=pathTab&visible=1`, { headers: { 'x-rdx-tab': '1' } })).status).toBe(204);
      expect((await fetch(`${url}/__rdx/command`)).status).toBe(404);
      const saved = JSON.parse(await readFile(join(dir, '.rdx', '.server.json'), 'utf8')) as {
        token: string;
        commandPath: string;
        url: string;
      };
      expect(saved).toMatchObject({ commandPath: '/api/dev/command', url });
      expect((await fetch(`${url}/api/dev/command`, { headers: { 'x-rdx-token': saved.token } })).status).toBe(200);
      const out = new PassThrough();
      let text = '';
      out.on('data', (d) => (text += String(d)));
      const code = await main(['tabs'], { stdout: out, stderr: new PassThrough(), stdin: new PassThrough(), cwd: dir, env: {} });
      expect(code).toBe(0);
      expect(text).toContain('pathTab');
    } finally {
      await new Promise<void>((resolve) => custom.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
