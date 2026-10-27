import { getNativeFetch } from '../capture/install.js';
import { isRenderMonitoring, setRenderMonitoring } from '../render/monitor.js';
import { buildReport, type RdxReport } from './buildReport.js';

/** dev 서버 플러그인(react-data-xray/vite, react-data-xray/middleware)이 받는 경로 */
export const REPORT_PATH = '/__rdx/report';
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

/**
 * 5초마다 보고서가 바뀌었으면 dev 서버로 보내 `.rdx/report.json` 에 쓰게 한다.
 * 플러그인이 없으면(404 등) 첫 응답에서 멈춘다.
 */
const startUpload = (): void => {
  let last = '';
  let timer = 0;
  const upload = async () => {
    // 플러그인이 있는지 확인하기 전에는 렌더 감시를 켜지 않는다(없는 앱에 비용만 더한다).
    const { generatedAt, ...content } = buildReport(isRenderMonitoring());
    const key = JSON.stringify(content);
    if (key === last) return;
    const body = JSON.stringify({ generatedAt, ...content });
    const res = await getNativeFetch()(REPORT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(
      () => null,
    );
    if (!res?.ok) {
      window.clearInterval(timer);
      return;
    }
    last = key;
    keepRenderMonitoring();
  };
  timer = window.setInterval(() => void upload(), UPLOAD_MS);
  void upload();
};

/** `window.__RDX__` 를 걸고, dev 서버 플러그인이 있으면 보고서를 파일로 보낸다. */
export const installReportApi = (): void => {
  if (typeof window === 'undefined' || window.__RDX__) return;
  window.__RDX__ = { report };
  startUpload();
};
