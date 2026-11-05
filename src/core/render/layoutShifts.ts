import { attempt } from '../capture/attempt.js';
import { getComponentName, getFiber, libraryPackageOf } from '../fiber/tree.js';
import { isComposite, type Fiber } from '../fiber/types.js';
import type { RequestRecord } from '../requests/types.js';
import { enqueue } from '../scheduler/idleQueue.js';
import { isIgnoredFiber, renderedAtOf, shiftCauseOf } from './monitor.js';
import type { NetworkCause } from './types.js';

// 오래 켜 둔 탭에서도 끝없이 늘지 않게 최근 이동만 둔다.
const MAX_SHIFTS = 200;
// 유휴 큐 한 조각에서 fiber 로 잇는 이동 수
const CHUNK = 16;

/** 브라우저가 주는 layout-shift 항목 중 rdx 가 읽는 것 */
interface LayoutShiftEntry {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
  sources?: ReadonlyArray<{ node?: Node | null }>;
}

/** 레이아웃 이동 하나. 밀린 노드를 fiber 로 바꾸고, 그 commit 의 네트워크 원인을 이은 결과다. */
export interface LayoutShift {
  id: number;
  /** 이동 시각(ms epoch) */
  time: number;
  /** 이 이동의 layout shift 점수(CLS 에 더해지는 값) */
  value: number;
  /** 밀린 노드를 그린 가장 가까운 앱 컴포넌트. 노드가 React 밖이거나 이미 지워졌으면 없다 */
  component?: { name: string; location?: string };
  /** 그 컴포넌트(또는 조상)를 이동 직전 commit 에서 렌더한 네트워크 응답 */
  cause?: { record: RequestRecord; via: NetworkCause['via']; component: string; location?: string };
}

let supported = false;
let nextId = 0;
// 마지막 reset 시각. 그 전에 일어나 늦게 분석된 이동은 버린다.
let measuredFrom = 0;
const shifts: LayoutShift[] = [];

/** 이 브라우저가 layout-shift 항목을 주는지(Chromium 계열만). 설치 전이면 false */
export const layoutShiftSupported = (): boolean => supported;

/** 노드를 그린 가장 가까운 앱 컴포넌트(라이브러리 컴포넌트만 있으면 그중 가장 가까운 것). rdx 패널이면 null */
const componentOf = (node: Node): Fiber | null | undefined => {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const host = el ? getFiber(el) : null;
  if (!host) return undefined;
  if (isIgnoredFiber(host)) return null;
  let library: Fiber | undefined;
  for (let f: Fiber | null = host; f; f = f.return) {
    if (!isComposite(f)) continue;
    if (!libraryPackageOf(f)) return f;
    library ??= f;
  }
  return library;
};

/** 항목 하나를 잇는다. 밀린 노드가 모두 rdx 패널 것이면 null(기록하지 않는다). */
const resolve = (entry: LayoutShiftEntry, time: number): LayoutShift | null => {
  const shift: LayoutShift = { id: ++nextId, time, value: entry.value };
  const sources = entry.sources ?? [];
  let own = sources.length > 0;
  // 밀린 노드가 여럿이면 원인 요청을 찾은 첫 노드를, 없으면 컴포넌트를 찾은 첫 노드를 쓴다.
  for (const source of sources) {
    const fiber = source.node ? componentOf(source.node) : undefined;
    if (fiber === null) continue;
    own = false;
    if (!fiber) continue;
    const found = shiftCauseOf(fiber, time);
    if (!shift.component || (found && !shift.cause)) {
      const location = renderedAtOf(fiber);
      shift.component = { name: getComponentName(fiber), ...(location && { location }) };
      if (found) shift.cause = { record: found.cause.record, via: found.cause.via, component: found.component, location: found.location };
    }
    if (shift.cause) break;
  }
  return own ? null : shift;
};

const record = (list: readonly LayoutShiftEntry[]): void => {
  let at = 0;
  enqueue(() => {
    for (const end = Math.min(at + CHUNK, list.length); at < end; at++) {
      const entry = list[at];
      // 사용자 입력 직후 500ms 안의 이동은 브라우저도 CLS 에서 뺀다(입력에 따른 예상된 이동).
      if (entry.hadRecentInput) continue;
      const time = performance.timeOrigin + entry.startTime;
      if (time < measuredFrom) continue;
      const shift = attempt(() => resolve(entry, time));
      if (!shift) continue;
      shifts.push(shift);
      if (shifts.length > MAX_SHIFTS) shifts.shift();
    }
    return at >= list.length;
  });
};

/**
 * 레이아웃 이동을 듣는다. 콜백에서는 항목 참조만 담고, fiber 잇기는 유휴 큐에서 한다.
 * layout-shift 를 주지 않는 브라우저(Safari, Firefox)에서는 아무것도 하지 않는다.
 */
export const trackLayoutShifts = (): void => {
  // 지원하지 않으면 다시 불러도 다시 확인할 뿐이다(설치는 installCapture 에서 한 번).
  if (supported) return;
  if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') return;
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes('layout-shift')) return;
  attempt(() => {
    // buffered: rdx 를 불러오기 전(첫 그리기)의 이동도 받는다.
    new PerformanceObserver((list) => record(list.getEntries() as unknown as LayoutShiftEntry[])).observe({
      type: 'layout-shift',
      buffered: true,
    });
    supported = true;
  });
};

/** 지금까지 분석된 이동(오래된 순). 큐에 남은 이동은 아직 없다. */
export const getLayoutShifts = (): readonly LayoutShift[] => shifts;

/** 측정을 새로 시작한다(window.__RDX__.reset). */
export const resetLayoutShifts = (now = Date.now()): void => {
  measuredFrom = now;
  shifts.length = 0;
};
