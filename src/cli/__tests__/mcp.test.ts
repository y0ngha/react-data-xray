// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../main.js';

let root = '';
let server: Server;
let base = '';
const deleted: string[] = [];

const REPORT = {
  requests: { endpoints: [{ endpoint: 'GET /a', count: 2, duplicates: 1, sameResponses: 0 }] },
  renders: { monitoring: true, windowSeconds: 10, components: [] },
  reactQuery: { findings: [] },
};

/** 탭 흉내 없이 명령 경로만 흉내 내는 dev 서버: 명령을 받으면 바로 done 으로 답한다 */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdx-mcp-'));
  await mkdir(join(root, '.rdx'));
  await writeFile(join(root, '.rdx', 'a.json'), JSON.stringify(REPORT));
  server = createServer((req, res) => {
    res.setHeader('x-rdx-report', '1');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'DELETE') {
      deleted.push(req.url ?? '');
      res.end(JSON.stringify({ id: 'c2', op: 'snapshot', tab: 'fake', status: 'expired' }));
    } else if (req.method === 'POST') {
      res.statusCode = 202;
      let text = '';
      req.on('data', (d) => (text += String(d)));
      req.on('end', () =>
        res.end(
          JSON.stringify({
            command: text.includes('"slow"')
              ? { id: 'c2', op: 'snapshot', name: 'slow', tab: 'fake', status: 'pending' }
              : { id: 'c1', op: 'reset', tab: 'fake', status: 'done' },
            others: [],
          }),
        ),
      );
    } else if (req.url?.startsWith('/__rdx/command/c2'))
      res.end(JSON.stringify({ id: 'c2', op: 'snapshot', tab: 'fake', status: 'pending' }));
    else res.end(JSON.stringify({ tabs: [{ id: 'fake', path: '/', title: '', seenAt: Date.now(), activeAt: 0 }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const a = server.address();
  base = `http://localhost:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** stdio 처럼 줄 단위로 보내고, 입력을 닫은 뒤 받은 답을 id 순으로 돌려준다 */
const session = async (messages: unknown[]) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (d) => (out += String(d)));
  const done = main(['mcp', '--url', base], { stdin, stdout, stderr: new PassThrough(), cwd: root, env: {} });
  messages.forEach((m) => stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`));
  stdin.end();
  expect(await done).toBe(0);
  return out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: number | null; result?: Record<string, unknown>; error?: { code: number } });
};

describe('rdx mcp(#69)', () => {
  it('initialize·tools/list·tools/call 을 stdio JSON-RPC 로 주고받는다', async () => {
    const replies = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reset', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'compare', arguments: { before: 'a', after: 'a' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'snapshot', arguments: { name: '../x' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'tabs' } },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ]);
    const byId = new Map(replies.map((r) => [r.id, r]));
    // 알림에는 답하지 않는다
    expect(replies).toHaveLength(7);
    expect(byId.get(1)?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'rdx' } });
    const { tools } = byId.get(2)!.result as { tools: Array<{ name: string; inputSchema: { type: string } }> };
    expect(tools.map((t) => t.name)).toEqual(['reset', 'snapshot', 'compare', 'report', 'tabs']);
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(byId.get(3)?.result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('Reset measurements in tab fake') }],
      isError: false,
    });
    const compared = byId.get(4)?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(compared.isError).toBe(false);
    expect(JSON.parse(compared.content[0].text)).toMatchObject({ requests: [], renders: [], warnings: [] });
    expect(byId.get(5)?.result).toMatchObject({ isError: true });
    expect(byId.get(6)?.result).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('fake') }] });
    expect(byId.get(7)?.result).toEqual({});
  });

  it('모르는 메서드·도구, 깨진 JSON 은 JSON-RPC 오류로 답하고, 처음 묻는 버전이 낯설면 아는 최신 버전으로 답한다', async () => {
    const replies = await session([
      'not json',
      '[1]',
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'eval', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report', arguments: { summary: true } } },
    ]);
    const byId = new Map(replies.filter((r) => r.id !== null).map((r) => [r.id, r]));
    expect(replies.filter((r) => r.id === null).map((r) => r.error?.code)).toEqual([-32700, -32600]);
    expect(byId.get(1)?.result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(byId.get(2)?.error?.code).toBe(-32601);
    expect(byId.get(3)?.error?.code).toBe(-32602);
    expect(byId.get(4)?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('No report at') }] });
  });

  it('클라이언트가 도구 호출을 취소하면(notifications/cancelled) 기다리던 명령을 dev 서버에서 거둔다', async () => {
    const replies = await session([
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'snapshot', arguments: { name: 'slow' } } },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, reason: 'user' } },
    ]);
    expect(deleted).toEqual(['/__rdx/command/c2']);
    expect(replies[0].result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Cancelled') }] });
  });
});
