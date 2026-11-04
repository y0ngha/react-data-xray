import { version as reactPackageVersion } from 'react';

import { captureStatus } from '../capture/install.js';
import { sourceMapFailures } from '../capture/sourceMap.js';
import { findRootFibers } from '../fiber/tree.js';
import type { Fiber } from '../fiber/types.js';
import { commitHookStatus } from '../render/devtoolsHook.js';
import { getReportPluginState, type ReportPluginState } from '../report/endpointState.js';
import { sameResponseMemory } from '../requests/repeatDetection.js';
import { getDroppedCount, getRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { earlyRequests, loadOrderFindings, loadOrderProblems, type EarlyRequests } from './loadOrder.js';
import { FIX_IMPORT_ORDER, MESSAGES } from './messages.js';

/** window.__RDX__.doctor() 와 보고서의 diagnostics: rdx 가 제대로 붙었는지 */
export interface RdxDiagnostics {
  renderHook: {
    /** React DevTools 전역 훅에 commit 리스너를 걸었는지 */
    listening: boolean;
    /** 지금까지 받은 commit 수(렌더 감시가 꺼져 있어도 센다). 앱이 그려졌는데 0 이면 react-dom 이 rdx 보다 먼저 로드됐다 */
    commitsSeen: number;
    reactVersion: string;
    /** 앱이 StrictMode 안에서 그려지는지(루트 근처의 fiber 와 StrictMode 재실행 요청으로 본다) */
    strictMode: boolean;
  };
  capture: {
    installed: boolean;
    fetch: boolean;
    xhr: boolean;
    /** rdx 가 설치되기 전에 나가 기록하지 못한 fetch·XHR 수(resource timing). 모르면 null */
    requestsBeforeInstall: number | null;
  };
  requests: {
    recorded: number;
    /** 응답 객체를 출처로 등록한 JSON 응답 수(요소 → 응답 연결의 재료) */
    jsonResponses: number;
    /** 200건을 넘어 목록에서 밀려난 수 */
    dropped: number;
  };
  /** dev 서버 보고서 플러그인: ready, missing(없음), forbidden-host(이 호스트를 막음), checking(확인 중) */
  reportPlugin: ReportPluginState;
  sourceMaps: { failures: number };
  /** 같은 응답 판정이 붙든 메모리: 요청 키 수와 남은 응답 글자 수(0 이어야 한다) */
  sameResponseMemory: { keys: number; retainedChars: number };
  /** 찾은 문제와 고치는 방법. 없으면 빈 배열 */
  problems: string[];
}

// React 18·19 의 StrictLegacyMode 비트. <StrictMode> 아래 fiber 는 모두 물려받는다.
const STRICT_LEGACY_MODE = 0b001000;
// StrictMode 는 보통 루트 바로 아래에 둔다. 트리 전체를 훑지 않게 이만큼만 본다.
const STRICT_SCAN_FIBERS = 300;

const underStrictMode = (roots: readonly Fiber[]): boolean => {
  const queue: Fiber[] = [...roots];
  for (let i = 0; i < queue.length && i < STRICT_SCAN_FIBERS; i++) {
    const fiber = queue[i];
    if (((fiber.mode ?? 0) & STRICT_LEGACY_MODE) !== 0) return true;
    for (let child = fiber.child; child; child = child.sibling) queue.push(child);
  }
  return false;
};

/** 응답 객체(객체·배열)가 있는 기록. 되살린 기록은 원문만 있어 빠진다. */
const hasJsonBody = (r: RequestRecord): boolean => r.body !== null && typeof r.body === 'object';

/** 앱에 도는 React 의 버전: 훅에 등록한 렌더러(react-dom)를 먼저, 없으면(훅에 붙지 않음) react 패키지 */
const reactVersionOf = (rendererVersions: readonly string[]): string => rendererVersions[0] ?? reactPackageVersion;

const hostname = (): string => (typeof location === 'undefined' ? 'localhost' : location.hostname);

/**
 * 문제 목록. 렌더 중에도 부를 수 있게 싼 값만 읽는다: early 를 주지 않으면 마운트 뒤 판정한 값을 쓰고,
 * commit 이 없다는 것은 앱이 그려진 것을 알 때(마운트 뒤 판정했거나 appRendered)만 문제로 본다.
 */
export const diagnosticProblems = (
  early: EarlyRequests | null = loadOrderFindings()?.early ?? null,
  appRendered = loadOrderFindings() !== null,
): string[] => {
  const hook = commitHookStatus();
  const capture = captureStatus();
  const memory = sameResponseMemory();
  const loadOrder = loadOrderProblems({ noCommits: appRendered && hook.listening && hook.commitsSeen === 0, early });
  return [
    ...loadOrder,
    ...(loadOrder.length > 0 ? [FIX_IMPORT_ORDER] : []),
    ...(capture.installed ? [] : [MESSAGES.captureMissing]),
    ...(getReportPluginState() === 'forbidden-host' ? [MESSAGES.forbiddenHost(hostname())] : []),
    ...(memory.retainedChars > 0 ? [MESSAGES.retainedText(memory.retainedChars)] : []),
  ];
};

/** 지금 상태로 자가 점검을 만든다. 큐를 비우지 않는다(이미 있는 카운터와 상태만 읽는다). */
export const buildDiagnostics = (): RdxDiagnostics => {
  const hook = commitHookStatus();
  const capture = captureStatus();
  const records = getRecords();
  const early = earlyRequests();
  const roots = typeof document === 'undefined' ? [] : findRootFibers();
  return {
    renderHook: {
      listening: hook.listening,
      commitsSeen: hook.commitsSeen,
      reactVersion: reactVersionOf(hook.rendererVersions),
      strictMode: records.some((r) => r.strictModeReplay) || underStrictMode(roots),
    },
    capture: { installed: capture.installed, fetch: capture.fetch, xhr: capture.xhr, requestsBeforeInstall: early?.count ?? null },
    requests: { recorded: records.length, jsonResponses: records.filter(hasJsonBody).length, dropped: getDroppedCount() },
    reportPlugin: getReportPluginState(),
    sourceMaps: { failures: sourceMapFailures() },
    sameResponseMemory: sameResponseMemory(),
    problems: diagnosticProblems(early, roots.length > 0 || loadOrderFindings() !== null),
  };
};

/** 데이터 관점의 빈 상태(연결된 응답·데이터를 쓰는 컴포넌트가 없음)에 붙일 이유. 모르면 undefined */
export const dataEmptyReason = (): string | undefined => {
  if (!captureStatus().installed) return MESSAGES.captureMissing;
  const records = getRecords();
  if (records.length === 0) return MESSAGES.noRequests;
  if (!records.some(hasJsonBody)) return MESSAGES.noJson(records.length);
  const early = loadOrderFindings()?.early;
  return early && early.count > 0 ? `${MESSAGES.earlyRequests(early.count, early.urls)} ${FIX_IMPORT_ORDER}` : undefined;
};

/** 렌더 관점의 빈 상태에 붙일 이유. 모르면 undefined */
export const renderEmptyReason = (): string | undefined => {
  const hook = commitHookStatus();
  return hook.listening && hook.commitsSeen === 0 ? `${MESSAGES.noCommits} ${FIX_IMPORT_ORDER}` : undefined;
};
