import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Readable, Writable } from 'node:stream';

import { EXIT, type CliOptions } from './client.js';
import { serveMcp } from './mcp.js';
import { compareTool, reportTool, resetTool, settle, snapshotTool, tabsTool, type ToolResult } from './tools.js';

export const USAGE = `Usage: rdx <command> [options]

Drive react-data-xray in the browser tab of a running dev server (no browser tool needed).

Commands:
  reset                    Start a fresh measurement in the tab
  snapshot <name>          Save the tab's report as .rdx/<name>.json
  compare <before> <after> Compare .rdx/<before>.json and .rdx/<after>.json (also writes .rdx/compare-<before>-<after>.json)
  report [--summary]       Print .rdx/report.json (--tab: that tab's report; --summary: only its summary)
  tabs                     List the browser tabs connected to the dev server
  mcp                      Run an MCP server over stdio with the same tools (claude mcp add rdx -- npx rdx mcp)

Options:
  --url <url>      Dev server address (default: RDX_URL, then the address the dev server saved in .rdx/.server.json)
  --tab <id>       Tab to run in (default: the most recently active connected tab; see rdx tabs)
  --dir <dir>      Report folder (default: .rdx)
  --timeout <s>    Seconds to wait for the tab to run a command (default: 90)

Exit codes: 0 ok, 1 failed, 2 usage, 3 dev server unreachable or without rdx, 4 no tab connected, 5 timed out.`;

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  cwd: string;
  env: Record<string, string | undefined>;
}

/** 패키지 버전(MCP 의 serverInfo). dist/cli 와 src/cli 둘 다 두 단계 위가 package.json 이다 */
const packageVersion = async (): Promise<string> => {
  try {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const usage = (text: string): ToolResult => ({ code: EXIT.usage, text: `${text}\n\n${USAGE}` });

const parse = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      tab: { type: 'string' },
      dir: { type: 'string' },
      timeout: { type: 'string' },
      summary: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

const print = (io: CliIo, { code, text }: ToolResult): number => {
  (code === EXIT.ok ? io.stdout : io.stderr).write(`${text}\n`);
  return code;
};

/** `rdx` 명령. 종료 코드를 돌려준다(process.exit 는 bin 이 한다) */
export const main = async (argv: readonly string[], io: CliIo): Promise<number> => {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return print(io, usage(error instanceof Error ? error.message : String(error)));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') return print(io, { code: command ? EXIT.ok : EXIT.usage, text: USAGE });
  const timeout = Number(values.timeout ?? 90);
  if (!Number.isFinite(timeout) || timeout <= 0)
    return print(io, usage(`--timeout must be a positive number of seconds: ${values.timeout}`));
  const opts: CliOptions = {
    url: values.url,
    tab: values.tab,
    dir: values.dir ?? '.rdx',
    cwd: io.cwd,
    timeoutMs: timeout * 1000,
    env: io.env,
  };
  switch (command) {
    case 'reset':
      return print(io, await settle(() => resetTool(opts)));
    case 'snapshot':
      return print(io, await settle(() => snapshotTool(opts, rest[0])));
    case 'compare':
      return print(io, await settle(() => compareTool(opts, rest[0], rest[1])));
    case 'report':
      return print(io, await settle(() => reportTool(opts, values.summary === true)));
    case 'tabs':
      return print(io, await settle(() => tabsTool(opts)));
    case 'mcp':
      // stdout 은 JSON-RPC 전용이다. 안내는 stderr 로만 낸다.
      await serveMcp(io.stdin, io.stdout, opts, await packageVersion());
      return EXIT.ok;
    default:
      return print(io, usage(`Unknown command: ${command}`));
  }
};
