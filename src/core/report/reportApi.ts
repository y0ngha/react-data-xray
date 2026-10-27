import { REPORT_HEADER, REPORT_PATH } from '../../shared/reportPath.js';
import { getNativeFetch } from '../capture/install.js';
import { isRenderMonitoring, setRenderMonitoring } from '../render/monitor.js';
import { buildReport, type RdxReport } from './buildReport.js';

const UPLOAD_MS = 5000;

declare global {
  interface Window {
    /** 브라우저 도구를 쓰는 AI 가 부른다: `window.__RDX__.report()` */
    __RDX__?: { report: () => RdxReport };
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

/** dev 서버에 rdx 미들웨어가 있는지. 본문 없는 GET 으로 묻고, 미들웨어만 붙이는 헤더로 판단한다. */
const hasReportEndpoint = async (send: typeof fetch): Promise<boolean> => {
  const res = await send(REPORT_PATH, { method: 'GET', credentials: 'omit' }).catch(() => null);
  return res?.headers.get(REPORT_HEADER) === '1';
};

/**
 * 5초마다 보고서가 바뀌었으면 dev 서버로 보내 `.rdx/report.json` 에 쓰게 한다.
 * 미들웨어가 없는 dev 서버는 이 경로를 원격 백엔드로 프록시하기도 하므로, 먼저 확인하고 없으면 아무것도 보내지 않는다.
 */
const startUpload = async (): Promise<void> => {
  const send = getNativeFetch();
  if (!send || !(await hasReportEndpoint(send))) return;
  keepRenderMonitoring();
  let last = '';
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
    // dev 서버 재시작처럼 잠깐 실패하면 다음 주기에 다시 보낸다.
    if (res?.ok) last = key;
  };
  window.setInterval(() => void upload(), UPLOAD_MS);
  await upload();
};

/** `window.__RDX__` 를 걸고, dev 서버 플러그인이 있으면 보고서를 파일로 보낸다. */
export const installReportApi = (): void => {
  if (typeof window === 'undefined' || window.__RDX__) return;
  window.__RDX__ = { report };
  void startUpload();
};
