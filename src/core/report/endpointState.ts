import { touchRecords } from '../requests/store.js';

/**
 * dev 서버 보고서 플러그인 상태. checking 은 확인 중, 나머지는 reportApi 의 checkEndpoint 가 정한 결과다.
 * rewritten 은 Next.js 의 middleware(proxy)가 rdx 경로를 다른 경로로 바꿔 라우트에 닿지 못한 것이다(#125).
 */
export type ReportPluginState = 'checking' | 'ready' | 'missing' | 'forbidden-host' | 'rewritten';

// 자가 점검(#76)이 기다리지 않고 읽을 수 있게 확인 결과를 따로 둔다(reportApi 는 buildReport 를 불러 그쪽에 두면 순환한다).
let state: ReportPluginState = 'missing';

// rewritten 일 때 막힌 경로와 middleware 가 바꾼 목적지(안내 문구에 쓴다)
let rewrite: { path: string; to: string } | undefined;

export const getReportPluginState = (): ReportPluginState => state;
export const getReportRewrite = (): { path: string; to: string } | undefined => rewrite;
export const setReportRewrite = (next: { path: string; to: string } | undefined): void => {
  rewrite = next;
};
/** 상태가 바뀌면 구독자(패널의 Status 버튼 등)에게 알린다. */
export const setReportPluginState = (next: ReportPluginState): void => {
  if (state === next) return;
  state = next;
  touchRecords();
};
