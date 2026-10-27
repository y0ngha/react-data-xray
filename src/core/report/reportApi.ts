import { REPORT_HEADER, REPORT_PATH } from '../../shared/reportPath.js';
import { getNativeFetch } from '../capture/nativeFetch.js';
import { isRenderMonitoring, resetRenderStats, setRenderMonitoring } from '../render/monitor.js';
import { clearRecords } from '../requests/store.js';
import { buildReport, type RdxReport } from './buildReport.js';

const UPLOAD_MS = 5000;

/** 브라우저 도구를 쓰는 AI·개발자가 부르는 창구 */
export interface RdxApi {
  /** 지금까지 모은 결과 */
  report: () => RdxReport;
  /** 측정을 새로 시작한다: 요청 기록과 렌더 통계를 비운다 */
  reset: () => void;
  /** 보고서를 이름 붙여 저장한다(.rdx/<name>.json, dev 서버 플러그인이 있을 때). 고치기 전후를 비교할 때 쓴다 */
  snapshot: (name: string) => Promise<RdxReport>;
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

// 보고서 이름: 파일 이름이 되므로 경로를 만들 수 있는 글자는 받지 않는다.
export const SNAPSHOT_NAME = /^[\w.-]{1,64}$/;

// 확인한 dev 서버 미들웨어가 있는지(업로드를 시작할 때 정한다)
let endpointReady = false;

const reset = (): void => {
  clearRecords();
  resetRenderStats();
};

const snapshot = async (name: string): Promise<RdxReport> => {
  if (!SNAPSHOT_NAME.test(name) || name.startsWith('.')) {
    throw new Error(`[react-data-xray] 보고서 이름은 영문·숫자·. _ - 로 64자까지입니다(. 으로 시작할 수 없습니다): ${name}`);
  }
  const result = report();
  const send = getNativeFetch();
  if (endpointReady && send) {
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
const hasReportEndpoint = async (send: typeof fetch): Promise<boolean> => {
  const ask = () => send(REPORT_PATH, { method: 'GET', credentials: 'omit' }).catch(() => null);
  const res = (await ask()) ?? (await new Promise((resolve) => window.setTimeout(resolve, HANDSHAKE_RETRY_MS)).then(ask));
  const mark = res?.headers.get(REPORT_HEADER);
  if (mark === 'forbidden-host') {
    console.warn(
      `[react-data-xray] dev 서버가 ${location.host} 에서 온 보고서를 막았습니다. rdx({ allowedHosts: ['${location.hostname}'] }) 로 허용하세요.`,
    );
  }
  return mark === '1';
};

/**
 * 5초마다 보고서가 바뀌었으면 dev 서버로 보내 `.rdx/report.json` 에 쓰게 한다.
 * 미들웨어가 없는 dev 서버는 이 경로를 원격 백엔드로 프록시하기도 하므로, 먼저 확인하고 없으면 아무것도 보내지 않는다.
 */
const startUpload = async (): Promise<void> => {
  const send = getNativeFetch();
  if (!send || !(await hasReportEndpoint(send))) return;
  endpointReady = true;
  keepRenderMonitoring();
  let last = '';
  let failures = 0;
  let timer = 0;
  const upload = async () => {
    const { generatedAt, ...content } = buildReport(isRenderMonitoring());
    const key = JSON.stringify(content);
    if (key === last) return;
    const body = JSON.stringify({ generatedAt, ...content });
    const res = await send(REPORT_PATH, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => null);
    if (res?.ok) {
      last = key;
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
  window.__RDX__ = { report, reset, snapshot };
  void startUpload();
};
