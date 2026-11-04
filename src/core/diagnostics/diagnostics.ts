import { version as reactPackageVersion } from 'react';

import { captureStatus } from '../capture/install.js';
import { sourceMapFailures } from '../capture/sourceMap.js';
import { commitHookStatus } from '../render/devtoolsHook.js';
import { strictModeSeen } from '../render/monitor.js';
import { getReportPluginState, type ReportPluginState } from '../report/endpointState.js';
import { sameResponseMemory } from '../requests/repeatDetection.js';
import { getDroppedCount, getRecords } from '../requests/store.js';
import type { RequestRecord } from '../requests/types.js';
import { loadOrderFindings, loadOrderProblems, type EarlyRequests } from './loadOrder.js';
import { FIX_IMPORT_ORDER, MESSAGES } from './messages.js';

/** window.__RDX__.doctor() 와 보고서의 diagnostics: rdx 가 제대로 붙었는지 */
export interface RdxDiagnostics {
  renderHook: {
    /** React DevTools 전역 훅에 commit 리스너를 걸었는지 */
    listening: boolean;
    /** 지금까지 받은 commit 수(렌더 감시가 꺼져 있어도 센다). 앱이 그려졌는데 0 이면 react-dom 이 rdx 보다 먼저 로드됐다 */
    commitsSeen: number;
    reactVersion: string;
    /** 앱이 StrictMode 안에서 그려지는지(기록한 앱 렌더의 fiber 모드로 본다). 아직 모르면 null */
    strictMode: boolean | null;
  };
  capture: {
    installed: boolean;
    fetch: boolean;
    xhr: boolean;
    /** rdx 가 설치되기 전에 나가 기록하지 못한 fetch·XHR 수(resource timing). 아직 판정하지 않았으면 null */
    requestsBeforeInstall: number | null;
  };
  requests: {
    /** 기록한 요청 수(새로고침 전에서 되살린 것 포함) */
    recorded: number;
    /** 그중 새로고침 전 페이지에서 되살린 것. 응답 객체가 없어 화면 값과 잇지 못한다 */
    restored: number;
    /** 응답 객체를 출처로 등록한 JSON 응답 수(요소 → 응답 연결의 재료) */
    jsonResponses: number;
    /** 200건을 넘어 목록에서 밀려난 수 */
    dropped: number;
  };
  /** dev 서버 보고서 플러그인: ready, missing(없음), forbidden-host(이 호스트를 막음), checking(확인 중) */
  reportPlugin: ReportPluginState;
  /** 소스맵을 받거나 읽지 못한 모듈 수 */
  sourceMaps: { failures: number };
  /** 같은 응답 판정이 붙든 메모리: 요청 키 수와 남은 응답 글자 수(0 이어야 한다) */
  sameResponseMemory: { keys: number; retainedChars: number };
  /** 찾은 문제와 고치는 방법. 없으면 빈 배열 */
  problems: string[];
}

/** 응답 객체(객체·배열)가 있는 기록 */
const hasJsonBody = (r: RequestRecord): boolean => r.body !== null && typeof r.body === 'object';

/** 앱에 도는 React 의 버전: 훅에 등록한 렌더러(react-dom)를 먼저, 없으면(훅에 붙지 않음) react 패키지 */
const reactVersionOf = (rendererVersions: readonly string[]): string => rendererVersions[0] ?? reactPackageVersion;

const host = (): [string, string] => (typeof location === 'undefined' ? ['localhost', 'localhost'] : [location.host, location.hostname]);

/** 판정한 import 순서 결과를 지금 값으로. commit 이 그 뒤에 왔으면 문제가 아니다. */
const loadOrderNow = (): { noCommits: boolean; early: EarlyRequests | null } => {
  const f = loadOrderFindings();
  return { noCommits: !!f?.noCommits && commitHookStatus().commitsSeen === 0, early: f?.early ?? null };
};

/**
 * 도구 막대 버튼에 다는 문제 수. 렌더마다 부르므로 배열을 만들거나 메모리를 훑지 않는다.
 * (같은 응답 메모리 점검은 doctor()·보고서에서만 한다.)
 */
export const problemCount = (): number => {
  const { noCommits, early } = loadOrderNow();
  return (
    Number(noCommits) +
    Number(!!early && early.count > 0) +
    Number(!captureStatus().installed) +
    Number(getReportPluginState() === 'forbidden-host')
  );
};

const problemsOf = (retainedChars: number): string[] => {
  const loadOrder = loadOrderProblems(loadOrderNow());
  // 고치는 방법은 import 순서 문제의 마지막 문구에 한 번만 붙인다.
  if (loadOrder.length > 0) loadOrder[loadOrder.length - 1] += ` ${FIX_IMPORT_ORDER}`;
  return [
    ...loadOrder,
    ...(captureStatus().installed ? [] : [MESSAGES.captureMissing]),
    ...(getReportPluginState() === 'forbidden-host' ? [MESSAGES.forbiddenHost(...host())] : []),
    ...(retainedChars > 0 ? [MESSAGES.retainedText(retainedChars)] : []),
  ];
};

/**
 * 지금 상태로 자가 점검을 만든다. 큐를 비우지 않고, 이미 있는 카운터와 판정 결과만 읽는다
 * (resource timing·DOM 은 다시 훑지 않는다: 설치 전 요청은 import 순서 판정 때 센 값이다).
 */
export const buildDiagnostics = (): RdxDiagnostics => {
  const hook = commitHookStatus();
  const capture = captureStatus();
  const records = getRecords();
  const live = records.filter((r) => !r.restored);
  const memory = sameResponseMemory();
  return {
    renderHook: {
      listening: hook.listening,
      commitsSeen: hook.commitsSeen,
      reactVersion: reactVersionOf(hook.rendererVersions),
      // 렌더 기록이 없으면 이 페이지에서 StrictMode 재실행으로 보낸 요청이 있는지로만 안다(되살린 기록은 빼고).
      strictMode: strictModeSeen() ?? (live.some((r) => r.strictModeReplay) ? true : null),
    },
    capture: {
      installed: capture.installed,
      fetch: capture.fetch,
      xhr: capture.xhr,
      requestsBeforeInstall: loadOrderFindings()?.early?.count ?? null,
    },
    requests: {
      recorded: records.length,
      restored: records.length - live.length,
      jsonResponses: live.filter(hasJsonBody).length,
      dropped: getDroppedCount(),
    },
    reportPlugin: getReportPluginState(),
    sourceMaps: { failures: sourceMapFailures() },
    sameResponseMemory: memory,
    problems: problemsOf(memory.retainedChars),
  };
};

/** 데이터 관점의 빈 상태(연결된 응답·데이터를 쓰는 컴포넌트가 없음)에 붙일 이유. 모르면 undefined */
export const dataEmptyReason = (): string | undefined => {
  if (!captureStatus().installed) return MESSAGES.captureMissing;
  // 되살린 기록은 원문만 있고 응답 객체가 없으므로 JSON 이었는지 따지는 데서 뺀다.
  const live = getRecords().filter((r) => !r.restored);
  if (live.length === 0) return MESSAGES.noRequests;
  if (!live.some(hasJsonBody)) return MESSAGES.noJson(live.length);
  const { early } = loadOrderNow();
  return early && early.count > 0 ? `${MESSAGES.earlyRequests(early.count, early.urls)} ${FIX_IMPORT_ORDER}` : undefined;
};

/** 렌더 관점의 빈 상태에 붙일 이유. 모르면 undefined */
export const renderEmptyReason = (): string | undefined => {
  const hook = commitHookStatus();
  return hook.listening && hook.commitsSeen === 0 ? `${MESSAGES.noCommits} ${FIX_IMPORT_ORDER}` : undefined;
};
