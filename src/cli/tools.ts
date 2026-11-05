import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RdxReport } from '../core/report/buildReport.js';
import { compare, toComparable, type ComparableReport } from '../core/report/compare.js';
import { DEFAULT_REPORT_NAME, isReportName, isTabId, reportFileFor, TABS_INDEX } from '../shared/reportPath.js';
import {
  CliError,
  describeTab,
  EXIT,
  formatTabs,
  listTabs,
  readDirFile,
  readReportFile,
  runCommand,
  type CliOptions,
  type CommandOutcome,
} from './client.js';

/** CLI 는 text 를 찍고 code 로 끝나며, MCP 는 text 를 돌려주고 code 가 0 이 아니면 isError 로 표시한다 */
export interface ToolResult {
  code: number;
  text: string;
}

const ok = (text: string): ToolResult => ({ code: EXIT.ok, text });

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/** 다른 탭도 연결돼 있으면 어느 탭에서 실행했는지와 고르는 법을 덧붙인다 */
const tabNote = ({ command, others }: CommandOutcome): string =>
  others.length ? `\nRan in tab ${command.tab}. Other connected tabs (pick one with --tab):\n${formatTabs(others)}` : '';

export const resetTool = async (opts: CliOptions): Promise<ToolResult> => {
  const outcome = await runCommand(opts, 'reset');
  return ok(
    `Reset measurements in tab ${outcome.command.tab}. Run the scenario, then save it with react-data-xray snapshot <name>.${tabNote(outcome)}`,
  );
};

export const snapshotTool = async (opts: CliOptions, name: string | undefined): Promise<ToolResult> => {
  if (!name || !isReportName(name))
    throw new CliError(
      `Report name must be up to 64 letters, digits, ., _ or - (cannot start with . or be 'report'): ${name ?? '(missing)'}`,
      EXIT.usage,
    );
  const outcome = await runCommand(opts, 'snapshot', name);
  return ok(`Saved ${opts.dir}/${name}.json from tab ${outcome.command.tab}.${tabNote(outcome)}`);
};

const isComparable = (v: unknown): v is ComparableReport => {
  const r = v as Partial<ComparableReport> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    Array.isArray(r.requests?.endpoints) &&
    Array.isArray(r.renders?.components) &&
    Array.isArray(r.reactQuery?.findings)
  );
};

/**
 * 저장한 두 보고서 파일(.rdx/<전>.json, .rdx/<후>.json)을 비교한다. 브라우저의 compare 는 그 탭의 sessionStorage 에 남은
 * 스냅샷만 읽어 탭을 새로 열면 못 쓰지만, 파일을 읽으면 탭과 상관없다. 브라우저처럼 `.rdx/compare-<전>-<후>.json` 에도 쓴다.
 */
export const compareTool = async (opts: CliOptions, before: string | undefined, after: string | undefined): Promise<ToolResult> => {
  if (!before || !after) throw new CliError('Usage: react-data-xray compare <before> <after>', EXIT.usage);
  const [a, b] = await Promise.all([readReportFile(opts, before), readReportFile(opts, after)]);
  for (const { file, value } of [a, b])
    if (!isComparable(value)) throw new CliError(`${file} is not an rdx report (no requests/renders/reactQuery).`, EXIT.failed);
  // 파일은 보고서 전체다. 브라우저 스냅샷과 같은 비교용 부분으로 줄여 비교한다(렌더 시간·낭비 fetch 묶음을 같은 이름으로 읽는다).
  const result = compare(toComparable(a.value as unknown as RdxReport), toComparable(b.value as unknown as RdxReport));
  const name = `compare-${before}-${after}`;
  if (isReportName(name)) {
    const folder = join(opts.cwd, opts.dir);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${name}.json`), `${pretty(result)}\n`).catch(() => undefined);
  }
  return ok(pretty(result));
};

/** `.rdx/report.json`(--tab 이면 그 탭의 파일). --summary 면 보고서의 summary 만(그런 필드가 없는 버전이면 전체와 안내) */
export const reportTool = async (opts: CliOptions, summary: boolean): Promise<ToolResult> => {
  if (opts.tab !== undefined && (!isTabId(opts.tab) || opts.tab === TABS_INDEX))
    throw new CliError(`Invalid tab id: ${opts.tab}`, EXIT.usage);
  const { file, value } = await readDirFile(opts, opts.tab === undefined ? `${DEFAULT_REPORT_NAME}.json` : reportFileFor(opts.tab));
  const report = value as { summary?: unknown } | null;
  if (!summary) return ok(pretty(report));
  if (report && report.summary !== undefined) return ok(typeof report.summary === 'string' ? report.summary : pretty(report.summary));
  return ok(`(${file} has no summary field in this rdx version; printing the full report)\n${pretty(report)}`);
};

export const tabsTool = async (opts: CliOptions): Promise<ToolResult> => {
  const tabs = await listTabs(opts);
  if (!tabs.length) return { code: EXIT.noTab, text: 'No browser tab is connected. Open the app in a browser and try again.' };
  return ok(
    `Connected tabs (visible and most recently focused first; path and title are set by the page):\n${tabs.map((t) => `  ${describeTab(t)}  (seen ${Math.round((Date.now() - t.seenAt) / 1000)}s ago)`).join('\n')}`,
  );
};

/** 실패를 종료 코드가 있는 결과로 바꾼다. 예상하지 못한 오류는 1 */
export const settle = (run: () => Promise<ToolResult>): Promise<ToolResult> =>
  run().catch((error: unknown) =>
    error instanceof CliError
      ? { code: error.code, text: error.message }
      : { code: EXIT.failed, text: error instanceof Error ? error.message : String(error) },
  );
