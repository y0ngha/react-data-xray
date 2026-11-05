/** rdx 보고서를 주고받는 dev 서버 경로. 브라우저(보고서 업로드)와 dev 서버(미들웨어)가 같이 쓴다. */
export const REPORT_PATH = '/__rdx/report';
/** 미들웨어가 붙어 있다는 표시. 이 헤더가 없으면 프록시·SPA 폴백이 답한 것이라 보고서를 보내지 않는다. */
export const REPORT_HEADER = 'x-rdx-report';
/** Next.js 가 middleware(proxy)의 rewrite 목적지를 알려 주는 응답 헤더. rdx 경로가 가로채였는지 볼 때 쓴다(#125). */
export const NEXT_REWRITE_HEADER = 'x-middleware-rewrite';
/** 자동 보고서 파일 이름(.rdx/report.json) */
export const DEFAULT_REPORT_NAME = 'report';

/**
 * snapshot 보고서 이름으로 쓸 수 있는지. 파일 이름이 되므로 경로를 만들 수 있는 글자와 . 으로 시작하는 이름은 받지 않고,
 * 5초마다 덮어쓰는 자동 보고서 이름도 받지 않는다
 * (대소문자를 가리지 않는 파일 시스템에서는 Report.json 도 같은 파일이다).
 */
export const isReportName = (name: string): boolean => /^[\w-][\w.-]{0,63}$/.test(name) && name.toLowerCase() !== DEFAULT_REPORT_NAME;

/** 탭 보고서 파일 이름이 되므로 경로를 만들 수 있는 글자는 받지 않는다. */
export const isTabId = (id: string): boolean => /^[\w-]{1,64}$/.test(id);
/** 탭 목록 파일(.rdx/tabs/index.json) 이름. 탭 id 는 index 일 수 없다 */
export const TABS_INDEX = 'index';
/** 이 탭의 보고서 파일(.rdx 기준 상대 경로) */
export const reportFileFor = (tabId: string): string => {
  if (!isTabId(tabId) || tabId === TABS_INDEX) throw new Error(`invalid tab id: ${tabId}`);
  return `tabs/${tabId}.json`;
};
/** 이 시간 동안 갱신이 없는 탭은 닫힌 것으로 보고 파일을 지운다 */
export const TAB_STALE_MS = 10 * 60 * 1000;
/** 열려 있는 탭은 보고서가 그대로여도 이 주기로 갱신 시각을 알려 지워지지 않게 한다 */
export const TAB_HEARTBEAT_MS = 4 * 60 * 1000;

/** CLI·MCP 가 열린 탭에 측정 명령(reset·snapshot)을 맡기는 dev 서버 경로. 브라우저는 보고서 경로로 받아 간다(#69) */
export const COMMAND_PATH = '/__rdx/command';

/**
 * 보고서 경로에 맞춘 명령 경로. 보고서 경로를 바꿨으면(서버의 `path`, 브라우저의 `configure({ reportPath })`) 같은 밑에 둔다:
 * `/x/report` → `/x/command`, 그 밖의 이름은 `/x/rdx` → `/x/rdx/command`. 기본값은 COMMAND_PATH 다.
 */
export const commandPathFor = (reportPath: string): string =>
  reportPath.endsWith('/report') ? `${reportPath.slice(0, -'report'.length)}command` : `${reportPath.replace(/\/$/, '')}/command`;
/** 탭에 맡길 수 있는 명령. 측정 기록만 바꾸는 것으로 한정한다(임의 코드 실행 없음) */
export const COMMAND_OPS = ['reset', 'snapshot'] as const;
export type CommandOp = (typeof COMMAND_OPS)[number];
export const isCommandOp = (op: unknown): op is CommandOp => (COMMAND_OPS as readonly unknown[]).includes(op);
/** dev 서버가 탭에 넘기는 명령 */
export interface RdxCommand {
  id: string;
  op: CommandOp;
  /** snapshot 의 보고서 이름 */
  name?: string;
}
/** 탭이 명령을 마치고 dev 서버에 알리는 결과 */
export interface RdxCommandResult {
  ok: boolean;
  error?: string;
}
/**
 * dev 서버가 명령 경로의 토큰과 마지막으로 본 브라우저 출처를 적는 파일(.rdx 기준). . 으로 시작해 snapshot 이름과 겹치지 않는다.
 * 같은 PC 에서 이 파일을 읽을 수 있는 쪽(CLI·MCP)만 명령을 보낼 수 있다.
 */
export const SERVER_FILE = '.server.json';
/** 명령 경로(`/__rdx/command`)의 모든 요청에 붙이는 토큰 헤더. 값은 SERVER_FILE 의 token */
export const TOKEN_HEADER = 'x-rdx-token';
/**
 * 탭이 받아 가기·알림 요청에 붙이는 헤더. 다른 사이트는 이 헤더를 붙이면 CORS preflight 가 필요해 보낼 수 없다.
 * 없는 GET 은 부수 효과 없는 핸드셰이크로 답한다(다른 사이트의 `<img>` 로 가짜 탭을 등록하지 못하게).
 */
export const TAB_HEADER = 'x-rdx-tab';
/** dev 서버가 받아 가기 응답에 붙여, 최근에 CLI·MCP 가 명령 경로를 썼다고 알리는 헤더. 그동안만 탭이 5초마다 받아 간다 */
export const CLI_ACTIVE_HEADER = 'x-rdx-cli';
/** CLI·MCP 가 명령 경로를 쓴 뒤 이만큼은 탭이 5초마다 받아 간다 */
export const CLI_ACTIVE_MS = 10 * 60 * 1000;
/**
 * CLI·MCP 가 쓰지 않을 때 탭이 받아 가는 주기(열려 있다는 알림도 된다). 오래 가려진 탭은 브라우저가 타이머를 1분에 한 번만 깨우므로
 * 1분보다 짧게 두어 깰 때마다 받아 가게 한다.
 */
export const QUIET_POLL_MS = 55 * 1000;
