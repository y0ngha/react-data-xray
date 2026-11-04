import { captureStatus } from '../capture/install.js';
import { findRootFibers } from '../fiber/tree.js';
import { commitHookStatus } from '../render/devtoolsHook.js';
import { touchRecords } from '../requests/store.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { FIX_IMPORT_ORDER, MESSAGES } from './messages.js';

/** rdx 가 설치되기 전에 시작한 fetch·XHR(resource timing 으로 센다) */
export interface EarlyRequests {
  count: number;
  /** 앞의 몇 건의 주소 */
  urls: string[];
}

const REQUEST_INITIATORS = new Set(['fetch', 'xmlhttprequest']);
const MAX_URLS = 3;
// 마운트 직후에는 rdx 보다 먼저 나간 요청이 아직 끝나지 않아 resource 항목이 없을 수 있다. 조금 기다렸다가 센다.
export const LOAD_CHECK_DELAY_MS = 2000;

/** 설치 시각보다 먼저 시작한 fetch·XHR. 설치하지 않았거나 resource timing 이 없으면 null */
export const earlyRequests = (): EarlyRequests | null => {
  const { installedAt } = captureStatus();
  if (installedAt === null || typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return null;
  const before = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(
    (e) => REQUEST_INITIATORS.has(e.initiatorType) && e.startTime < installedAt,
  );
  return { count: before.length, urls: before.slice(0, MAX_URLS).map((e) => e.name) };
};

/** 판정한 결과 */
export interface LoadOrderFindings {
  /** 앱이 그려졌는데도 commit 을 하나도 받지 못했다: react-dom 이 rdx 보다 먼저 로드됐다 */
  noCommits: boolean;
  early: EarlyRequests | null;
  /** 판정할 때 앱이 그려져 있었는지(패널이 마운트됐거나 React 루트가 있음). false 면 commit 은 판정하지 않았다 */
  appRendered: boolean;
}

// 패널 없이 보고서만 쓰는 설정에서 앱이 늦게 그려지면, 그려질 때까지 이만큼 다시 본다.
const MAX_CHECKS = 5;

let findings: LoadOrderFindings | null = null;
let pending = false;
let checks = 0;
let panelMounted = false;
let warnedCommits = false;
let warnedEarly = false;

/** 판정한 결과. 아직 판정하지 않았으면 null */
export const loadOrderFindings = (): LoadOrderFindings | null => findings;

/** 판정 결과를 문제 문구로. 없으면 빈 배열(고치는 방법은 붙이지 않는다) */
export const loadOrderProblems = (f: Pick<LoadOrderFindings, 'noCommits' | 'early'>): string[] => [
  ...(f.noCommits ? [MESSAGES.noCommits] : []),
  ...(f.early && f.early.count > 0 ? [MESSAGES.earlyRequests(f.early.count, f.early.urls)] : []),
];

const appRendered = (): boolean => panelMounted || (typeof document !== 'undefined' && findRootFibers().length > 0);

/** 지금 판정하고, 새로 찾은 문제가 있으면 콘솔에 한 번(문제마다 페이지당 한 번) 고치는 방법과 함께 알린다. */
export const checkLoadOrder = (): LoadOrderFindings => {
  const hook = commitHookStatus();
  const rendered = appRendered();
  findings = { noCommits: rendered && hook.listening && hook.commitsSeen === 0, early: earlyRequests(), appRendered: rendered };
  const fresh = loadOrderProblems({
    noCommits: findings.noCommits && !warnedCommits,
    early: warnedEarly ? null : findings.early,
  });
  if (findings.noCommits) warnedCommits = true;
  if (findings.early && findings.early.count > 0) warnedEarly = true;
  if (fresh.length > 0) {
    console.warn(`[react-data-xray] ${fresh.join(' ')} ${FIX_IMPORT_ORDER}`);
    touchRecords(); // 패널(Status 버튼, 빈 상태 문구)이 다시 그려 이유를 보이게 한다
  }
  return findings;
};

/**
 * 잠시 뒤 유휴 큐에서 판정한다. 진입 모듈(import 시점)과 <RdxDevtools> 마운트(panel) 양쪽에서 부르고, 걸린 판정이 있으면 하나로 합친다.
 * 앱이 그려진 뒤 한 번 판정하면 더 하지 않는다. 앱 경로에서는 아무것도 하지 않는다: commit 마다 카운터 하나만 올린다.
 */
export const scheduleLoadOrderCheck = ({ panel = false } = {}, delayMs = LOAD_CHECK_DELAY_MS): void => {
  if (panel) panelMounted = true;
  if (pending || findings?.appRendered || typeof window === 'undefined') return;
  pending = true;
  window.setTimeout(
    () =>
      enqueue(() => {
        pending = false;
        checks++;
        // 아직 앱이 그려지지 않았으면 조금 뒤 다시 본다(패널이 마운트되면 그쪽이 다시 건다).
        if (!checkLoadOrder().appRendered && checks < MAX_CHECKS) scheduleLoadOrderCheck({}, delayMs);
        return true;
      }),
    delayMs,
  );
};
