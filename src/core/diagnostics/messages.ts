// 자가 점검(#75, #76)의 문구를 한곳에 둔다. 언어 선택(#45)이 생기면 이 파일만 바꾼다.
// 보고서(diagnostics.problems)에도 들어가므로 영어로 쓴다(보고서에는 한글이 없어야 한다).

/** import 순서를 고치는 방법. import 문 모양으로 쓰면 check:side-effects 가 번들에 남은 import 로 오인한다. */
export const FIX_IMPORT_ORDER =
  'Move the react-data-xray import to the very top of your entry file, before react-dom and your app code (Next.js: put it in instrumentation-client.ts).';

const list = (urls: readonly string[], count: number): string =>
  urls.length === 0 ? '' : ` (${urls.join(', ')}${count > urls.length ? ', …' : ''})`;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export const MESSAGES = {
  noCommits:
    "No React commit has reached rdx although the app has rendered: 'react-data-xray' was imported after react-dom, so render counts and render causes stay empty.",
  earlyRequests: (count: number, urls: readonly string[]): string =>
    `${plural(count, 'fetch/XHR request')} went out before rdx loaded and ${count === 1 ? 'was' : 'were'} not recorded${list(urls, count)}.`,
  captureMissing: 'Request capture is not installed, so no request is recorded.',
  forbiddenHost: (host: string, hostname: string): string =>
    `The dev server blocked a report from ${host}. Allow this host in the rdx report plugin: Vite rdx({ allowedHosts: ['${hostname}'] }), webpack rdxReportMiddleware(root, { allowedHosts: ['${hostname}'] }), Next.js createRdxReportRoute(process.cwd(), { allowedHosts: ['${hostname}'] }).`,
  retainedText: (chars: number): string =>
    `Same-response detection holds ${chars} characters of response text; it should keep only lengths and hashes.`,
  noRequests:
    'No requests recorded on this page yet (records restored from before a reload have no response objects to link). Data rendered on the server (SSR/RSC) cannot be linked to a response; if the page fetched on load, check the import order.',
  noJson: (count: number): string =>
    `None of the ${plural(count, 'response')} recorded on this page was JSON with objects or arrays, so there is nothing to link. Data rendered on the server cannot be linked either.`,
} as const;

/** 패널 상태 줄의 이름 */
export const STATUS_LABELS = {
  button: 'Status',
  buttonTitle: 'Is rdx connected? Same as window.__RDX__.doctor()',
  renderHook: 'Render hook',
  noCommits: 'no commits',
  notListening: 'not installed',
  commits: 'commits',
  strictMode: 'StrictMode',
  capture: 'Capture',
  captureOff: 'off',
  requests: 'requests',
  jsonResponses: 'JSON with sources',
  beforeLoad: 'before rdx',
  reportPlugin: 'Report plugin',
  sourceMaps: 'Source map failures',
  sameResponse: 'Same-response memory',
  keys: 'keys',
  ok: 'No problems found.',
} as const;
