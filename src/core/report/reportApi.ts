import { isReportName, REPORT_HEADER, REPORT_PATH, reportFileFor, TAB_HEARTBEAT_MS } from '../../shared/reportPath.js';
import { getNativeFetch } from '../capture/nativeFetch.js';
import { whenSourcesResolved } from '../capture/requestContext.js';
import { isRenderMonitoring, resetRenderStats, setRenderMonitoring } from '../render/monitor.js';
import { resetCacheAudit } from '../reactQuery/cacheAudit.js';
import { readStored, writeStored } from '../../shared/storage.js';
import { clearRecords } from '../requests/store.js';
import { buildReport, type RdxReport } from './buildReport.js';
import { compare, toComparable, type ComparableReport, type ReportComparison } from './compare.js';

const UPLOAD_MS = 5000;
const TAB_ID_KEY = 'rdx:tabId';
const SNAPSHOTS_KEY = 'rdx:snapshots';
const SNAPSHOT_ORDER_KEY = 'rdx:snapshotOrder';
const RESET_AT_KEY = 'rdx:resetAt';
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
/** snapshot 이 저장에 성공했을 때 부른다(테스트에서 직접 부르기도 한다) */
export const keepSnapshot = (name: string, value: RdxReport): void => {
  const all = readSnapshots();
  all[name] = toComparable(value);
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
          `[react-data-xray] '${name}' 보고서를 이 탭에 남기지 못했습니다(저장 공간 부족). 파일(.rdx/${name}.json)에는 저장됐습니다.`,
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
  /** 지금까지 모은 결과 */
  report: () => RdxReport;
  /** 측정을 새로 시작한다: 요청 기록과 렌더 통계를 비운다 */
  reset: () => void;
  /** 보고서를 이름 붙여 저장한다(.rdx/<name>.json). 고치기 전후를 비교할 때 쓴다. 저장하지 못하면(플러그인 없음 등) 거부된다 */
  snapshot: (name: string) => Promise<RdxReport>;
  /** 이 탭에서 저장한 두 보고서(전, 후)의 증감을 돌려주고 .rdx/compare-<전>-<후>.json 에도 쓴다(쓰지 못해도 거부되지 않는다) */
  compare: (before: string, after: string) => Promise<ReportComparison>;
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

const report = (): RdxReport => {
  const monitoring = isRenderMonitoring();
  keepRenderMonitoring();
  return buildReport(monitoring);
};

const HANDSHAKE_RETRY_MS = 3000;
// dev 서버가 꺼지면 계속 실패하므로 이만큼 연속 실패하면 멈춘다. 서버가 돌아오면 Vite 가 페이지를 다시 열어 처음부터 확인한다.
const MAX_UPLOAD_FAILURES = 3;

type Endpoint = 'ready' | 'forbidden-host' | 'missing';
// dev 서버 미들웨어가 있는지 확인한 결과. snapshot 이 확인이 끝나기 전에 불려도 기다린다.
let endpoint: Promise<Endpoint> = Promise.resolve('missing');

/** 이 탭에서 마지막으로 reset 한 시각(콘솔의 reset() 도 반영된다) */
export const getResetAt = (): number | null =>
  readStored<number | null>(RESET_AT_KEY, (v) => (typeof v === 'number' ? v : undefined), null, 'session');

const reset = (): void => {
  writeStored(RESET_AT_KEY, Date.now(), 'session');
  // 시나리오 동안의 렌더를 잡도록 감시부터 켠다(플러그인 확인 전이거나 플러그인이 없어도).
  keepRenderMonitoring();
  clearRecords();
  resetRenderStats();
  resetCacheAudit();
};

const snapshot = async (name: string): Promise<RdxReport> => {
  if (!isReportName(name)) {
    throw new Error(
      `[react-data-xray] 보고서 이름은 영문·숫자·. _ - 로 64자까지입니다(. 으로 시작하거나 'report' 일 수 없습니다): ${name}`,
    );
  }
  const send = getNativeFetch();
  const state = send ? await endpoint : 'missing';
  if (state === 'forbidden-host') {
    throw new Error(
      `[react-data-xray] dev 서버가 ${location.host} 에서 온 보고서를 막았습니다. rdx({ allowedHosts: ['${location.hostname}'] }) 로 허용하세요.`,
    );
  }
  if (!send || state === 'missing') {
    throw new Error('[react-data-xray] dev 서버에 rdx 플러그인이 없어 저장하지 못했습니다. window.__RDX__.report() 로 받으세요.');
  }
  // 호출 위치가 원본 위치와 변환 전 위치로 갈리지 않게, 진행 중인 소스맵 변환을 기다린다.
  await whenSourcesResolved();
  const result = report();
  const res = await send(`${REPORT_PATH}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  }).catch(() => null);
  if (!res?.ok) throw new Error(`[react-data-xray] .rdx/${name}.json 을 쓰지 못했습니다(${res ? res.status : '응답 없음'}).`);
  keepSnapshot(name, result);
  return result;
};

const compareSnapshots = async (before: string, after: string): Promise<ReportComparison> => {
  const a = getSnapshot(before);
  const b = getSnapshot(after);
  if (!a || !b)
    throw new Error(
      `[react-data-xray] 이 탭에서 저장한 보고서가 아닙니다: ${a ? after : before} (저장한 이름: ${snapshotNames().join(', ') || '없음'})`,
    );
  const result = compare(a, b);
  const name = `compare-${before}-${after}`;
  const send = getNativeFetch();
  if (send && isReportName(name) && (await endpoint) === 'ready') {
    await send(`${REPORT_PATH}?name=${encodeURIComponent(name)}`, {
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
const checkEndpoint = async (send: typeof fetch): Promise<Endpoint> => {
  const ask = () => send(REPORT_PATH, { method: 'GET', credentials: 'omit' }).catch(() => null);
  const res = (await ask()) ?? (await new Promise((resolve) => window.setTimeout(resolve, HANDSHAKE_RETRY_MS)).then(ask));
  const mark = res?.headers.get(REPORT_HEADER);
  if (mark === 'forbidden-host') {
    console.warn(
      `[react-data-xray] dev 서버가 ${location.host} 에서 온 보고서를 막았습니다. rdx({ allowedHosts: ['${location.hostname}'] }) 로 허용하세요.`,
    );
  }
  return mark === '1' ? 'ready' : mark === 'forbidden-host' ? 'forbidden-host' : 'missing';
};

/**
 * 5초마다 보고서가 바뀌었으면 dev 서버로 보내 `.rdx/report.json` 에 쓰게 한다.
 * 미들웨어가 없는 dev 서버는 이 경로를 원격 백엔드로 프록시하기도 하므로, 먼저 확인하고 없으면 아무것도 보내지 않는다.
 */
const startUpload = async (): Promise<void> => {
  const send = getNativeFetch();
  if (!send) return;
  endpoint = checkEndpoint(send);
  if ((await endpoint) !== 'ready') return;
  keepRenderMonitoring();
  let last = '';
  let lastSent = 0;
  let failures = 0;
  let timer = 0;
  const upload = async () => {
    const { generatedAt, ...content } = buildReport(isRenderMonitoring(), Date.now(), false); // 주기 업로드는 큐를 비우지 않는다
    const key = JSON.stringify(content);
    const idle = key === last;
    // 그대로여도 열려 있다는 것은 가끔 알린다(서버가 오래 갱신 없는 탭 파일을 지운다).
    if (idle && Date.now() - lastSent < TAB_HEARTBEAT_MS) return;
    const body = JSON.stringify({ generatedAt, ...content });
    const query = new URLSearchParams({ tab: getTabId(), path: location.pathname, title: document.title });
    if (idle) query.set('idle', '1');
    const res = await send(`${REPORT_PATH}?${query}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => null);
    if (res?.ok) {
      last = key;
      lastSent = Date.now();
      failures = 0;
      return;
    }
    // 잠깐 실패하면 다음 주기에 다시 보내고, 계속 실패하면 멈춘다.
    failures++;
    if (failures >= MAX_UPLOAD_FAILURES) window.clearInterval(timer);
  };
  timer = window.setInterval(() => void upload(), UPLOAD_MS);
  await upload();
};

/** `window.__RDX__` 를 걸고, dev 서버 플러그인이 있으면 보고서를 파일로 보낸다. */
export const installReportApi = (): void => {
  if (typeof window === 'undefined' || window.__RDX__) return;
  window.__RDX__ = { report, reset, snapshot, compare: compareSnapshots };
  watchTabIdConflict();
  void startUpload();
};
