import { isReportName, REPORT_HEADER, reportFileFor, TAB_HEADER, TAB_HEARTBEAT_MS } from '../../shared/reportPath.js';
import { config, subscribeConfig } from '../config.js';
import { getNativeFetch } from '../capture/nativeFetch.js';
import { whenSourcesResolved } from '../capture/requestContext.js';
import { isRenderMonitoring, resetRenderStats, setRenderMonitoring } from '../render/monitor.js';
import { resetCacheAudit } from '../reactQuery/cacheAudit.js';
import { resetLayoutShifts } from '../render/layoutShifts.js';
import { readStored, writeStored } from '../../shared/storage.js';
import { clearRecords } from '../requests/store.js';
import { getResetAt, writeResetAt } from './resetAt.js';
import { buildReport, buildSnapshotReport, type RdxReport, type ReportOptions } from './buildReport.js';
import { buildDiagnostics, type RdxDiagnostics } from '../diagnostics/diagnostics.js';
import { MESSAGES } from '../diagnostics/messages.js';
import { setReportPluginState } from './endpointState.js';
import { notePolled, notePollSent, receiveCommands, shouldPoll, tabState } from './commands.js';
import { compare, toComparable, type ComparableReport, type ReportComparison } from './compare.js';
import type { RenderRowTally } from './renderSection.js';

// 처리기가 이 Host 를 막았을 때의 안내는 MESSAGES.forbiddenHost 한곳에 둔다(Vite·webpack·Next.js 를 함께 적는다).
const UPLOAD_MS = 5000;
const TAB_ID_KEY = 'rdx:tabId';
const SNAPSHOTS_KEY = 'rdx:snapshots';
const SNAPSHOT_ORDER_KEY = 'rdx:snapshotOrder';
const MAX_SNAPSHOTS = 6;

// 저장한 보고서의 비교용 부분을 이 탭 sessionStorage 에도 남긴다. 고친 뒤 새로고침해도 전후를 비교할 수 있게 한다.
// 전체 보고서를 남기면 앱의 sessionStorage 용량을 다투므로 compare 가 읽는 값만 둔다.
const readSnapshots = (): Record<string, ComparableReport> =>
  readStored<Record<string, ComparableReport>>(
    SNAPSHOTS_KEY,
    (v) => (typeof v === 'object' && v !== null ? (v as Record<string, ComparableReport>) : undefined),
    {},
    'session',
  );

/** 이 탭에서 snapshot 으로 저장한 보고서 이름(오래된 것부터). 객체 키 순서는 숫자 이름이 앞서므로 저장 순서를 따로 둔다. */
export const snapshotNames = (): string[] => {
  const all = readSnapshots();
  const order = readStored<string[]>(
    SNAPSHOT_ORDER_KEY,
    (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string') : undefined),
    [],
    'session',
  );
  return [...new Set([...order, ...Object.keys(all)])].filter((n) => n in all);
};
export const getSnapshot = (name: string): ComparableReport | undefined => readSnapshots()[name];
/**
 * snapshot 이 저장에 성공했을 때 부른다(테스트에서 직접 부르기도 한다). renderBeyondCap 은 그 보고서와 함께 만든
 * 상한 밖 렌더 행이다(buildSnapshotReport). 없으면 보고서에 있는 행만 남긴다
 */
export const keepSnapshot = (name: string, value: RdxReport, renderBeyondCap: readonly RenderRowTally[] = []): void => {
  const all = readSnapshots();
  all[name] = toComparable(value, renderBeyondCap);
  let keep = [...snapshotNames().filter((n) => n !== name), name].slice(-MAX_SNAPSHOTS);
  // 용량이 넘치면 들어갈 때까지 오래된 것부터 버린다. 방금 저장한 것도 못 넣으면 알린다.
  for (;;) {
    try {
      sessionStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(Object.fromEntries(keep.map((n) => [n, all[n]]))));
      sessionStorage.setItem(SNAPSHOT_ORDER_KEY, JSON.stringify(keep));
      return;
    } catch {
      if (keep.length <= 1) {
        console.warn(
          `[react-data-xray] Could not keep the '${name}' report in this tab (storage full). It was saved to the file (.rdx/${name}.json).`,
        );
        return;
      }
      keep = keep.slice(1);
    }
  }
};

const newTabId = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/** 이 탭의 id. 새로고침해도 같고(sessionStorage), 새 탭은 새로 만든다. */
export const getTabId = (): string => {
  const saved = readStored<string>(TAB_ID_KEY, (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined), '', 'session');
  if (saved) return saved;
  const id = newTabId();
  writeStored(TAB_ID_KEY, id, 'session');
  return id;
};

/**
 * 탭을 복제하면 sessionStorage 가 복사돼 두 탭이 같은 id 를 쓴다(서로의 보고서 파일을 덮어쓴다).
 * 열 때 알리고, 같은 id 를 쓰는 탭이 있으면 나중에 열린 쪽이 새 id 를 받는다.
 */
export const watchTabIdConflict = (): void => {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('rdx:tabs');
  (channel as { unref?: () => void }).unref?.();
  const born = Date.now();
  const token = newTabId();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel 에는 targetOrigin 이 없다
  const hello = () => channel.postMessage({ id: getTabId(), born, token });
  channel.addEventListener('message', ({ data }: MessageEvent<{ id?: string; born?: number; token?: string } | null>) => {
    if (!data || data.token === undefined || data.token === token || data.id !== getTabId()) return;
    const mineIsLater = data.born! < born || (data.born === born && data.token < token);
    if (mineIsLater) writeStored(TAB_ID_KEY, newTabId(), 'session');
    else hello(); // 먼저 열린 쪽은 id 를 지키고, 뒤에 열린 쪽이 바꾸도록 알린다.
  });
  hello();
};

/** 이 탭 보고서의 dev 서버 쪽 경로(프로젝트 루트 기준) */
export const tabReportPath = (dir = '.rdx'): string => `${dir}/${reportFileFor(getTabId())}`;

/** 브라우저 도구를 쓰는 AI·개발자가 부르는 창구 */
export interface RdxApi {
  /** 지금까지 모은 결과. `report({ howToRead: false })` 는 howToRead 를 뺀다(howToReadVersion 은 남는다) */
  report: (options?: ReportOptions) => RdxReport;
  /** 측정을 새로 시작한다: 요청 기록과 렌더 통계를 비운다 */
  reset: () => void;
  /** 보고서를 이름 붙여 저장한다(.rdx/<name>.json). 고치기 전후를 비교할 때 쓴다. 저장하지 못하면(플러그인 없음 등) 거부된다 */
  snapshot: (name: string) => Promise<RdxReport>;
  /** 이 탭에서 저장한 두 보고서(전, 후)의 증감을 돌려주고 .rdx/compare-<전>-<후>.json 에도 쓴다(쓰지 못해도 거부되지 않는다) */
  compare: (before: string, after: string) => Promise<ReportComparison>;
  /** rdx 가 제대로 붙었는지 자가 점검: 렌더 훅·가로채기·기록·보고서 플러그인·소스맵 상태와, 찾은 문제(problems) */
  doctor: () => RdxDiagnostics;
}

declare global {
  interface Window {
    /** 브라우저 도구를 쓰는 AI 가 부른다: `window.__RDX__.report()` */
    __RDX__?: RdxApi;
  }
}

// 보고서를 읽는 쪽(AI)이 렌더 정보도 보려면 감시가 켜져 있어야 한다. 한 번 켜면 끄지 않는다.
let keptOn = false;
const keepRenderMonitoring = (): void => {
  if (keptOn) return;
  keptOn = true;
  setRenderMonitoring(true);
};

/** dev 서버에 rdx 플러그인이 없어 snapshot 이 파일로 저장하지 못했을 때의 오류 문구. 패널은 이 오류면 탭에만 남긴다. */
export const NO_PLUGIN_MESSAGE =
  '[react-data-xray] The dev server has no rdx plugin; could not save. Use window.__RDX__.report() to retrieve the report.';

// 파일로 남기는 보고서(snapshot·주기 업로드)는 나중에 읽을 쪽을 모르므로 늘 howToRead 를 싣는다.
const report = (options?: ReportOptions): RdxReport => {
  const monitoring = isRenderMonitoring();
  keepRenderMonitoring();
  return buildReport(monitoring, Date.now(), true, options);
};

const HANDSHAKE_RETRY_MS = 3000;
// 이만큼 연속으로 올리지 못하면 올리기를 쉬고 받아 가기(본문 없는 GET)만 가끔 보낸다. 받아 가기가 되면 다시 올린다.
const MAX_UPLOAD_FAILURES = 3;

type Endpoint = 'ready' | 'forbidden-host' | 'missing';
// dev 서버 미들웨어가 있는지 그 경로로 확인한 결과. snapshot 이 확인이 끝나기 전에 불려도 기다린다.
let checked: { path: string; state: Promise<Endpoint> } | undefined;
// 주기 업로드가 도는 중(확인 중 포함)인지. reportPath 가 바뀌었을 때 멈춰 있으면 다시 시작한다.
let uploading = false;

export { getResetAt };

const reset = (): void => {
  writeResetAt(Date.now());
  // 시나리오 동안의 렌더를 잡도록 감시부터 켠다(플러그인 확인 전이거나 플러그인이 없어도).
  keepRenderMonitoring();
  clearRecords();
  resetRenderStats();
  resetCacheAudit();
  resetLayoutShifts();
};

const snapshot = async (name: string): Promise<RdxReport> => {
  if (!isReportName(name)) {
    throw new Error(
      `[react-data-xray] Report name must be up to 64 characters using letters, digits, ., _, or - (cannot start with . or be 'report'): ${name}`,
    );
  }
  const send = getNativeFetch();
  const target = send && endpointFor(send);
  const state = target ? await target.state : 'missing';
  if (state === 'forbidden-host') {
    throw new Error(`[react-data-xray] ${MESSAGES.forbiddenHost(location.host, location.hostname)}`);
  }
  if (!send || !target || state === 'missing') {
    throw new Error(NO_PLUGIN_MESSAGE);
  }
  // 호출 위치가 원본 위치와 변환 전 위치로 갈리지 않게, 진행 중인 소스맵 변환을 기다린다.
  const resolved = await whenSourcesResolved();
  const monitoring = isRenderMonitoring();
  keepRenderMonitoring();
  const { report: result, renderBeyondCap } = buildSnapshotReport(monitoring, Date.now(), { sourceMapTimedOut: !resolved });
  const res = await send(`${target.path}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  }).catch(() => null);
  if (!res?.ok) throw new Error(`[react-data-xray] Could not write .rdx/${name}.json (${res ? res.status : 'no response'}).`);
  keepSnapshot(name, result, renderBeyondCap);
  return result;
};

/** dev 서버 플러그인이 없어 파일로 못 남길 때 이 탭에만 남긴다(패널 Save). snapshot 과 같은 비교용 부분을 남긴다 */
export const keepTabSnapshot = (name: string): RdxReport => {
  const monitoring = isRenderMonitoring();
  keepRenderMonitoring();
  const { report: saved, renderBeyondCap } = buildSnapshotReport(monitoring);
  keepSnapshot(name, saved, renderBeyondCap);
  return saved;
};

const compareSnapshots = async (before: string, after: string): Promise<ReportComparison> => {
  const a = getSnapshot(before);
  const b = getSnapshot(after);
  if (!a || !b)
    throw new Error(
      `[react-data-xray] Not a report saved in this tab: ${a ? after : before} (saved names: ${snapshotNames().join(', ') || 'none'})`,
    );
  const result = compare(a, b);
  const name = `compare-${before}-${after}`;
  const send = getNativeFetch();
  const target = send && isReportName(name) ? endpointFor(send) : undefined;
  if (send && target && (await target.state) === 'ready') {
    await send(`${target.path}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    }).catch(() => null);
  }
  return result;
};

/**
 * dev 서버에 rdx 미들웨어가 있는지. 본문 없는 GET 으로 묻고, 미들웨어만 붙이는 헤더로 판단한다.
 * 의존성 최적화 리로드 중처럼 응답이 아예 없으면 한 번 더 묻는다. 응답이 왔는데 표시가 없으면 미들웨어가 없는 것이다(프록시·SPA 폴백).
 */
const checkEndpoint = async (send: typeof fetch, path: string): Promise<Endpoint> => {
  const ask = () => send(path, { method: 'GET', credentials: 'omit' }).catch(() => null);
  const res = (await ask()) ?? (await new Promise((resolve) => window.setTimeout(resolve, HANDSHAKE_RETRY_MS)).then(ask));
  const mark = res?.headers.get(REPORT_HEADER);
  if (mark === 'forbidden-host') {
    console.warn(`[react-data-xray] ${MESSAGES.forbiddenHost(location.host, location.hostname)}`);
  }
  return mark === '1' ? 'ready' : mark === 'forbidden-host' ? 'forbidden-host' : 'missing';
};

/** 지금 reportPath 를 확인한 결과. 경로가 바뀌었으면(configure) 다시 묻는다. 확인하지 않은 경로로는 보내지 않는다. */
const endpointFor = (send: typeof fetch): { path: string; state: Promise<Endpoint> } => {
  const path = config().reportPath;
  if (checked?.path !== path) {
    // 자가 점검(doctor)이 보는 상태도 함께 바꾼다. 늦게 끝난 앞 경로의 결과가 덮어쓰지 않게 지금 경로일 때만 적는다.
    setReportPluginState('checking');
    const target = { path, state: checkEndpoint(send, path) };
    checked = target;
    void target.state.then((state) => checked === target && setReportPluginState(state));
  }
  return checked;
};

/**
 * 주기 업로드가 "바뀌었나" 를 볼 때 쓰는 값. 받은 commit 수는 패널 자신의 commit 에도 늘어, 그대로 비교하면
 * 앱이 멈춰 있어도 5초마다 전체를 보낸다. 0 인지(연결 여부)만 남긴다. 완료 표시(complete·incompleteReasons·pendingAnalysis·
 * sourcesResolved·queryKeysResolved)도 패널이 도는 동안 늘 흔들리므로 뺀다. 덜 분석된 파일이 따라잡는 것은 startUpload 가
 * complete 가 false → true 로 바뀔 때 한 번 보내서 맞춘다. 보내는 본문에는 그대로 둔다.
 */
export const changeKeyOf = ({
  complete: _complete,
  incompleteReasons: _reasons,
  pendingAnalysis: _pending,
  sourcesResolved: _sources,
  queryKeysResolved: _queryKeys,
  ...content
}: Omit<RdxReport, 'generatedAt'>): string =>
  JSON.stringify({
    ...content,
    diagnostics: {
      ...content.diagnostics,
      renderHook: { ...content.diagnostics.renderHook, commitsSeen: content.diagnostics.renderHook.commitsSeen > 0 },
    },
  });

/**
 * 5초마다 보고서가 바뀌었으면 dev 서버로 보내 `.rdx/report.json` 에 쓰게 한다.
 * 미들웨어가 없는 dev 서버는 이 경로를 원격 백엔드로 프록시하기도 하므로, 먼저 확인하고 없으면 아무것도 보내지 않는다.
 */
const startUpload = async (): Promise<void> => {
  const send = getNativeFetch();
  if (!send || uploading) return;
  uploading = true;
  // 확인은 한 마이크로태스크 뒤에 보낸다. `import 'react-data-xray'` 바로 뒤의 configure({ reportPath }) 가 먼저 돌아야 그 경로로 묻는다.
  await Promise.resolve();
  if ((await endpointFor(send).state) !== 'ready') {
    uploading = false;
    return;
  }
  keepRenderMonitoring();
  let last = '';
  let lastSent = 0;
  let sentComplete = true; // 마지막으로 보낸 파일이 끝난 보고서였는지
  let failures = 0;
  const upload = async () => {
    // 도중에 reportPath 가 바뀌었으면 새 경로를 먼저 확인한다. 없으면 이번 주기는 보내지 않는다.
    const target = endpointFor(send);
    if ((await target.state) !== 'ready') return;
    const full = buildReport(isRenderMonitoring(), Date.now(), false); // 주기 업로드는 큐를 비우지 않는다
    const { generatedAt: _generatedAt, ...content } = full;
    const key = changeKeyOf(content);
    // 덜 분석된 파일을 보낸 뒤 분석이 끝나면, 내용이 그대로여도 한 번 보내 파일이 complete: true 로 따라잡게 한다.
    const caughtUp = full.complete && !sentComplete;
    const idle = key === last && !caughtUp;
    const tab = getTabId();
    // 그대로여도 열려 있다는 것은 가끔 알린다(서버가 오래 갱신 없는 탭 파일을 지운다).
    // 올리지 않는 주기에도 CLI·MCP 가 맡긴 명령을 본문 없는 GET 으로 받아 간다(#69). CLI 를 쓰지 않을 때는 1분 안쪽마다.
    // 업로드가 계속 실패하면(dev 서버를 다시 띄우는 중 등) 올리기를 쉬고 받아 가기만 한다. 받아 가기가 되면 다시 올린다.
    const quiet = failures >= MAX_UPLOAD_FAILURES || (idle && Date.now() - lastSent < TAB_HEARTBEAT_MS);
    if (quiet && !shouldPoll(Date.now())) return;
    const query = new URLSearchParams({ tab, path: location.pathname, title: document.title, ...tabState() });
    if (idle) query.set('idle', '1');
    // 받아 가기 주기는 보낸 때부터 센다(업로드도 응답으로 명령을 받으므로 받아 가기로 친다).
    notePollSent(Date.now());
    const res = await send(
      `${target.path}?${query}`,
      quiet
        ? { method: 'GET', credentials: 'omit', headers: { [TAB_HEADER]: '1' } }
        : {
            method: 'POST',
            credentials: 'omit',
            headers: { 'content-type': 'application/json', [TAB_HEADER]: '1' },
            body: JSON.stringify(full), // summary 가 맨 앞에 오도록 키 순서를 그대로 둔다
          },
    ).catch(() => null);
    if (res?.ok) {
      if (!quiet) {
        last = key;
        lastSent = Date.now();
        sentComplete = full.complete;
      }
      failures = 0;
      notePolled(res);
      await receiveCommands(send, target.path, res, tab, { reset, snapshot });
      return;
    }
    // 잠깐 실패하면 다음 주기에 다시 보낸다. 받아 가기의 실패는 세지 않는다(그때는 이미 쉬는 중이거나 보고서가 그대로다).
    // 멈추지 않는다: 멈추면 dev 서버를 다시 띄운 뒤 CLI 명령이 탭에 닿지 않는다.
    if (!quiet) failures++;
  };
  window.setInterval(() => void upload(), UPLOAD_MS);
  await upload();
};

/** `window.__RDX__` 를 걸고, dev 서버 플러그인이 있으면 보고서를 파일로 보낸다. */
export const installReportApi = (): void => {
  if (typeof window === 'undefined' || window.__RDX__) return;
  window.__RDX__ = { report, reset, snapshot, compare: compareSnapshots, doctor: () => buildDiagnostics() };
  watchTabIdConflict();
  void startUpload();
  // 확인한 뒤에 reportPath 를 바꾸면(늦은 configure) 그 경로로 다시 확인해 업로드를 시작한다.
  subscribeConfig(() => {
    if (checked && checked.path !== config().reportPath && !uploading) void startUpload();
  });
};
