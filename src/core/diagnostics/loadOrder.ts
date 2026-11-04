import { captureStatus } from '../capture/install.js';
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

/** <RdxDevtools> 가 마운트된 뒤 한 번 판정한 결과 */
export interface LoadOrderFindings {
  /** 마운트(자기 commit) 뒤에도 commit 을 하나도 받지 못했다: react-dom 이 rdx 보다 먼저 로드됐다 */
  noCommits: boolean;
  early: EarlyRequests | null;
}

let findings: LoadOrderFindings | null = null;
let scheduled = false;

/** 마운트 뒤 판정한 결과. 아직 판정하지 않았으면 null */
export const loadOrderFindings = (): LoadOrderFindings | null => findings;

/** 판정 결과를 문제 문구로. 없으면 빈 배열 */
export const loadOrderProblems = (f: LoadOrderFindings): string[] => [
  ...(f.noCommits ? [MESSAGES.noCommits] : []),
  ...(f.early && f.early.count > 0 ? [MESSAGES.earlyRequests(f.early.count, f.early.urls)] : []),
];

/** 지금 판정하고, 문제가 있으면 콘솔에 한 번(페이지당) 고치는 방법과 함께 알린다. */
export const checkLoadOrder = (): LoadOrderFindings => {
  const hook = commitHookStatus();
  const first = findings === null;
  findings = { noCommits: hook.listening && hook.commitsSeen === 0, early: earlyRequests() };
  const problems = loadOrderProblems(findings);
  if (first && problems.length > 0) {
    console.warn(`[react-data-xray] ${problems.join(' ')} ${FIX_IMPORT_ORDER}`);
    touchRecords(); // 패널(Status 버튼, 빈 상태 문구)이 다시 그려 이유를 보이게 한다
  }
  return findings;
};

/**
 * <RdxDevtools> 가 마운트된 뒤(자기 commit 이 훅을 지난 뒤) 부른다. 잠시 뒤 유휴 큐에서 한 번만 판정한다.
 * 앱 경로에서는 아무것도 하지 않는다: commit 마다 카운터 하나만 올리고, resource 조회는 이 한 번뿐이다.
 */
export const scheduleLoadOrderCheck = (delayMs = LOAD_CHECK_DELAY_MS): void => {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  window.setTimeout(
    () =>
      enqueue(() => {
        checkLoadOrder();
        return true;
      }),
    delayMs,
  );
};
