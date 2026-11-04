import { countProblems, isWastefulStat } from '../problems.js';
import type { CacheFindingKind } from '../reactQuery/cacheAudit.js';
import type { ReactQuerySection } from './reactQuerySection.js';
import type { RenderSection } from './renderSection.js';
import type { RequestSection } from './requestSection.js';

const MAX_TOP_FINDINGS = 10;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type FindingKind = 'duplicate' | 'same-response' | 'react-query' | 'render-storm' | 'avoidable-renders' | 'remount';

export interface TopFinding {
  kind: FindingKind;
  /** high: RDX 버튼 배지가 세는 문제(낭비 요청 엔드포인트, 렌더 폭주 컴포넌트). medium: 배지는 세지 않지만 줄일 수 있는 것 */
  severity: 'high' | 'medium';
  /** react-query 일 때 reactQuery.findings[].kind */
  rule?: CacheFindingKind;
  /** 고칠 대상. location 은 보낸 코드 위치(callers)·그리는 JSX 위치(renderedAt)·호출 위치(stack) 중 아는 것 */
  target: { endpoint?: string; component?: string; queryKeys?: string[]; location?: string };
  /** 판단 근거 수치 */
  evidence: Record<string, number>;
  /** 고치면 줄어들 것으로 보는 양. ms 는 dev 빌드에서 잰 값이다 */
  savings?: { requests?: number; renders?: number; ms?: number };
  fix?: string;
  /** 상세 항목의 경로(예: requests.endpoints[0]). 보고서 범위 밖이라 상세 행이 없으면 두지 않는다 */
  detail?: string;
}

export interface ReportSummary {
  /** 한 줄 판정 */
  verdict: string;
  /** RDX 버튼 배지가 이 보고서를 만든 때 세는 문제 수와 그 내역 */
  badge: { issues: number; wasteEndpoints: number; stormingComponents: number };
  /** 고칠 순서대로(severity, 그다음 요청 → React Query → 렌더 → 재마운트, 그다음 추정 절감) 최대 10개 */
  topFindings: TopFinding[];
  /** topFindings 에 싣지 못한 finding 수 */
  omitted: number;
}

// 같은 severity 안에서 읽는 순서. SKILL 의 점검 순서(낭비 요청 → React Query → 렌더)를 따른다.
const KIND_ORDER: Record<FindingKind, number> = {
  duplicate: 0,
  'same-response': 0,
  'react-query': 1,
  'render-storm': 2,
  'avoidable-renders': 2,
  remount: 3,
};

// 고칠 것이 없는 React Query finding(아직 없는 쿼리를 무효화한 것은 정상이다)
const NOTHING_TO_FIX: ReadonlySet<CacheFindingKind> = new Set(['invalidate-unloaded']);

interface Ranked extends TopFinding {
  score: number;
}

const requestFindings = (requests: RequestSection): Ranked[] =>
  requests.endpoints.flatMap((e, i) => {
    if (e.ignored || !isWastefulStat(e)) return [];
    const wasted = e.duplicates + e.sameResponses;
    const caller = e.callers[0];
    return [
      {
        kind: e.duplicates >= e.sameResponses ? 'duplicate' : 'same-response',
        severity: 'high',
        target: {
          endpoint: e.endpoint,
          ...((caller?.component ?? caller?.observer) && { component: caller.component ?? caller.observer }),
          ...(caller?.frame && { location: caller.frame }),
        },
        evidence: {
          count: e.count,
          duplicates: e.duplicates,
          sameResponses: e.sameResponses,
          ...(e.failedDuplicates > 0 && { failedDuplicates: e.failedDuplicates }),
        },
        savings: { requests: wasted, ms: Math.round(wasted * e.avgMs) },
        detail: `requests.endpoints[${i}]`,
        score: wasted,
      },
    ];
  });

const reactQueryFindings = (reactQuery: ReactQuerySection): Ranked[] =>
  reactQuery.findings.flatMap((f, i) => {
    if (NOTHING_TO_FIX.has(f.kind)) return [];
    const location = f.stack ?? f.stacks?.[0];
    return [
      {
        kind: 'react-query',
        severity: 'medium',
        rule: f.kind,
        target: { queryKeys: f.keys.slice(0, 3), ...(location && { location }) },
        evidence: { keys: f.keys.length, requests: f.requests.length, ...(f.count !== undefined && { count: f.count }) },
        fix: f.fix,
        detail: `reactQuery.findings[${i}]`,
        score: f.count ?? f.requests.length,
      },
    ];
  });

const renderFindings = (renders: RenderSection, storms: ReadonlyMap<string, number>): Ranked[] => {
  const rows = renders.components.flatMap((c, i): Ranked[] => {
    const storm = storms.get(c.name);
    const target = { component: c.name, ...(c.renderedAt && { location: c.renderedAt }) };
    const out: Ranked[] = [];
    if (storm !== undefined || c.avoidable > 0) {
      out.push({
        kind: c.avoidable > 0 ? 'avoidable-renders' : 'render-storm',
        severity: storm !== undefined ? 'high' : 'medium',
        target,
        evidence: {
          renders: c.renders,
          avoidable: c.avoidable,
          ...(storm !== undefined && { rendersLast10s: storm }),
          ...(c.time && { totalMs: c.time.totalMs }),
        },
        ...(c.avoidable > 0 && { savings: { renders: c.avoidable, ...(c.time && { ms: c.time.avoidableMs }) } }),
        ...(c.advice[0] && { fix: c.advice[0] }),
        detail: `renders.components[${i}]`,
        score: c.avoidable || c.renders,
      });
    }
    const remounts = c.mounts?.remounts ?? [];
    const remounted = remounts.reduce((n, r) => n + r.count, 0);
    if (remounted > 0) {
      out.push({
        kind: 'remount',
        severity: 'medium',
        target,
        evidence: { remounts: remounted, mounts: c.mounts!.mounts },
        fix: `Stabilize the subtree in ${remounts[0].parent}${remounts[0].cause === 'type-changed' ? ' (a component is defined inside a render)' : ''} so it is not swapped; mount effects run again on every remount.`,
        detail: `renders.components[${i}].mounts`,
        score: remounted,
      });
    }
    return out;
  });
  // 폭주 중인데 보고서 구간·상위 행에 없는 컴포넌트도 배지가 세므로 남긴다.
  const shown = new Set(renders.components.map((c) => c.name));
  const missing = Array.from(storms, ([name, recent]): Ranked => ({
    kind: 'render-storm',
    severity: 'high',
    target: { component: name },
    evidence: { rendersLast10s: recent },
    score: recent,
  })).filter((f) => !shown.has(f.target.component!));
  return [...rows, ...missing];
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * 이미 만든 섹션에서 고칠 것을 순위대로 뽑는다. 새로 분석하지 않는다.
 * storms 는 배지와 같은 기준(`findRenderStorms`)으로 찾은 렌더 폭주 컴포넌트다.
 */
export const buildSummary = (
  requests: RequestSection,
  reactQuery: ReactQuerySection,
  renders: RenderSection,
  storms: ReadonlyMap<string, number>,
): ReportSummary => {
  const all = [...requestFindings(requests), ...reactQueryFindings(reactQuery), ...renderFindings(renders, storms)].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.score - a.score,
  );
  const wasteEndpoints = requests.endpoints.filter((e) => !e.ignored && isWastefulStat(e));
  const wastedRequests = wasteEndpoints.reduce((n, e) => n + e.duplicates + e.sameResponses, 0);
  const avoidable = renders.components.filter((c) => c.avoidable > 0);
  const avoidableRenders = avoidable.reduce((n, c) => n + c.avoidable, 0);
  const avoidableMs = round1(avoidable.reduce((n, c) => n + (c.time?.avoidableMs ?? 0), 0));
  const rqCount = reactQuery.findings.filter((f) => !NOTHING_TO_FIX.has(f.kind)).length;
  const issues = countProblems(wasteEndpoints.length, storms.size);
  const verdict = [
    `${plural(wasteEndpoints.length, 'endpoint')} with wasted requests (${plural(wastedRequests, 'request')})`,
    `${plural(avoidable.length, 'component')} with avoidable renders (${plural(avoidableRenders, 'render')}${avoidableMs > 0 ? `, ${avoidableMs}ms` : ''})`,
    `${plural(rqCount, 'React Query finding')}`,
    `RDX badge ${issues}${renders.monitoring ? '' : ' (render monitoring was off)'}`,
  ].join(', ');
  return {
    verdict,
    badge: { issues, wasteEndpoints: wasteEndpoints.length, stormingComponents: storms.size },
    topFindings: all.slice(0, MAX_TOP_FINDINGS).map(({ score: _score, ...f }) => f),
    omitted: Math.max(0, all.length - MAX_TOP_FINDINGS),
  };
};

/** summary 를 먼저 읽으라는 줄. buildReport 가 howToRead 맨 앞에 둔다. */
export const SUMMARY_HOW_TO_READ: readonly string[] = [
  'Read summary first. summary.verdict is a one-line count of the problems; summary.topFindings lists up to 10 things to fix, in the order to fix them, and summary.omitted is how many more were left out.',
  'topFindings[].severity high means the RDX button badge counts it (an endpoint with wasted requests, or a component rendering 10+ times within the last 10s — the same rule as summary.badge); medium means it can be reduced but the badge does not count it. Within a severity, requests come first, then React Query, renders, and remounts, then the largest estimated savings.',
  'topFindings[].detail is the path of the full entry in this report (e.g. requests.endpoints[0]); read it and confirm in code before fixing. target.location is the sending code (callers), the JSX location (renderedAt), or the call site (stack), whichever is known. savings is an estimate (ms values are dev-build sums).',
];
