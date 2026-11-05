import { round3 } from '../../shared/format.js';
import { countProblems, type RenderStorm } from '../problems.js';
import type { CacheFindingKind } from '../reactQuery/cacheAudit.js';
import { WINDOW_MS } from '../render/summary.js';
import { RENDER_STORM } from '../render/types.js';
import { LARGE_LAYOUT_SHIFT, MAX_LAYOUT_SHIFT_ROWS, type LayoutShiftRow } from './layoutShiftSection.js';
import type { ReactQuerySection } from './reactQuerySection.js';
import { MAX_RENDER_GROUPS, type RenderSection } from './renderSection.js';
import type { RequestSection } from './requestSection.js';

const MAX_TOP_FINDINGS = 10;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type FindingKind = 'duplicate' | 'same-response' | 'react-query' | 'render-storm' | 'avoidable-renders' | 'layout-shift' | 'remount';

export interface TopFinding {
  kind: FindingKind;
  /** high: RDX 버튼 배지가 세는 문제(낭비 요청 엔드포인트, 렌더 폭주 컴포넌트 그룹). medium: 배지는 세지 않지만 줄일 수 있는 것 */
  severity: 'high' | 'medium';
  /** react-query 일 때 reactQuery.findings[].kind */
  rule?: CacheFindingKind;
  /**
   * 고칠 대상. location 은 낭비를 가장 많이 낸 보낸 코드 위치(callers)·그리는 JSX 위치(renderedAt)·호출 위치(stack) 중 아는 것.
   * library 는 앱 컴포넌트 행의 libraries 에 접힌 라이브러리 컴포넌트("패키지 이름")이고, 그때 component 는 그것을 그린 앱 컴포넌트다.
   */
  target: { endpoint?: string; component?: string; library?: string; queryKeys?: string[]; location?: string };
  /** 판단 근거 수치 */
  evidence: Record<string, number>;
  /** 고치면 줄어들 것으로 보는 양. ms 는 dev 빌드에서 잰 값이다 */
  savings?: { requests?: number; renders?: number; ms?: number };
  fix?: string;
  /** 상세 항목의 경로(예: requests.endpoints[0]). 보고서 범위 밖이라 상세 행이 없으면 두지 않는다 */
  detail?: string;
}

export interface ReportSummary {
  /** 한 줄 판정. 렌더 행이 상한(30)까지 차서 더 있을 수 있으면 수 뒤에 + 를 붙인다 */
  verdict: string;
  /** RDX 버튼 배지가 이 보고서를 만든 때 세는 문제 수와 그 내역(배지와 같은 함수로 센다) */
  badge: { issues: number; wasteEndpoints: number; stormingComponents: number };
  /** 고칠 순서대로(severity, 그다음 요청 → React Query → 렌더 → 레이아웃 이동 → 재마운트, 그다음 추정 절감이 큰 순) 최대 10개 */
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
  'layout-shift': 3,
  remount: 4,
};

// 고칠 것이 없는 React Query finding(아직 없는 쿼리를 무효화한 것은 정상이다)
const NOTHING_TO_FIX: ReadonlySet<CacheFindingKind> = new Set(['invalidate-unloaded']);

// 정렬 키: 추정 절감(줄일 요청 수·렌더 수. 절감을 셀 수 없는 종류는 그 종류의 크기), 그다음 절감 ms, 그다음 크기(호출·렌더 수)
interface Ranked extends TopFinding {
  rank: [number, number, number];
}

type Endpoint = RequestSection['endpoints'][number];
type Component = RenderSection['components'][number];

/** 낭비를 가장 많이 낸 보낸 위치. 보고서에 실린 callers(호출 수 상위 3) 중 낭비를 낸 것이 없으면 위치를 모른다고 본다 */
const wastefulCaller = (e: Endpoint): Endpoint['callers'][number] | undefined =>
  e.callers.reduce<Endpoint['callers'][number] | undefined>((best, c) => ((c.waste ?? 0) > (best?.waste ?? 0) ? c : best), undefined);

const requestFindings = (endpoints: readonly Endpoint[], wasteful: ReadonlySet<Endpoint>): Ranked[] =>
  endpoints.flatMap((e, i): Ranked[] => {
    if (!wasteful.has(e)) return [];
    const wasted = e.duplicates + e.sameResponses;
    const caller = wastefulCaller(e);
    const component = caller?.component ?? caller?.observer;
    const ms = Math.round(wasted * e.avgMs);
    return [
      {
        kind: e.duplicates >= e.sameResponses ? 'duplicate' : 'same-response',
        severity: 'high',
        target: { endpoint: e.endpoint, ...(component && { component }), ...(caller?.frame && { location: caller.frame }) },
        evidence: {
          count: e.count,
          duplicates: e.duplicates,
          sameResponses: e.sameResponses,
          ...(e.failedDuplicates > 0 && { failedDuplicates: e.failedDuplicates }),
        },
        savings: { requests: wasted, ms },
        detail: `requests.endpoints[${i}]`,
        rank: [wasted, ms, e.count],
      },
    ];
  });

const reactQueryFindings = (reactQuery: ReactQuerySection): Ranked[] =>
  reactQuery.findings.flatMap((f, i): Ranked[] => {
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
        rank: [f.count ?? f.requests.length, 0, f.requests.length],
      },
    ];
  });

const sameRow = (c: Component, name: string, location: string | undefined): boolean =>
  !c.package && c.name === name && c.renderedAt === location;

/**
 * 폭주 그룹이 가리킬 보고서 행. 앱 컴포넌트는 이름 + 그리는 위치가 같은 행(렌더 그룹 키와 같다),
 * 라이브러리 컴포넌트는 그린 앱 컴포넌트 행의 libraries 항목(그 앱 행이 없으면 따로 남은 패키지 행).
 */
const stormRowOf = (components: readonly Component[], s: RenderStorm): { row: number; library?: number } | undefined => {
  if (!s.package) {
    const row = components.findIndex((c) => sameRow(c, s.name, s.location));
    return row < 0 ? undefined : { row };
  }
  const owner = s.owner ? components.findIndex((c) => sameRow(c, s.owner!.name, s.owner!.location)) : -1;
  const library = owner < 0 ? -1 : (components[owner].libraries ?? []).findIndex((l) => l.package === s.package && l.name === s.name);
  if (library >= 0) return { row: owner, library };
  const row = components.findIndex((c) => c.package === s.package && c.name === s.name);
  return row < 0 ? undefined : { row };
};

interface RenderNumbers {
  renders: number;
  avoidable: number;
  avoidableMs?: number;
  totalMs?: number;
  storm?: number;
}

const renderFinding = (
  severity: TopFinding['severity'],
  target: TopFinding['target'],
  n: RenderNumbers,
  detail?: string,
  fix?: string,
): Ranked => ({
  kind: n.avoidable > 0 ? 'avoidable-renders' : 'render-storm',
  severity,
  target,
  evidence: {
    renders: n.renders,
    avoidable: n.avoidable,
    ...(n.storm !== undefined && { rendersLast10s: n.storm }),
    ...(n.totalMs !== undefined && { totalMs: n.totalMs }),
  },
  ...(n.avoidable > 0 && { savings: { renders: n.avoidable, ...(n.avoidableMs !== undefined && { ms: n.avoidableMs }) } }),
  ...(fix && { fix }),
  ...(detail && { detail }),
  rank: [n.avoidable, n.avoidableMs ?? 0, n.renders],
});

const stormTarget = (s: RenderStorm): TopFinding['target'] =>
  s.package && s.owner
    ? { component: s.owner.name, library: `${s.package} ${s.name}`, ...(s.owner.location && { location: s.owner.location }) }
    : { component: s.name, ...(s.location && { location: s.location }) };

const remountFinding = (c: Component, i: number, target: TopFinding['target']): Ranked[] => {
  const remounts = c.mounts?.remounts ?? [];
  const remounted = remounts.reduce((n, r) => n + r.count, 0);
  if (remounted === 0) return [];
  const inRender = remounts[0].cause === 'type-changed' ? ' (a component is defined inside a render)' : '';
  return [
    {
      kind: 'remount',
      severity: 'medium',
      target,
      evidence: { remounts: remounted, mounts: c.mounts!.mounts },
      fix: `Stabilize the subtree in ${remounts[0].parent}${inRender} so it is not swapped; mount effects run again on every remount.`,
      detail: `renders.components[${i}].mounts`,
      rank: [remounted, 0, c.mounts!.mounts],
    },
  ];
};

const renderFindings = (renders: RenderSection, storms: ReadonlyMap<string, RenderStorm>): Ranked[] => {
  // 행(또는 행의 libraries 항목)마다 그 자리에서 폭주 중인 그룹. 같은 이름이라도 다른 위치의 행은 high 로 올리지 않는다.
  const stormAt = new Map<string, RenderStorm>();
  const missing: RenderStorm[] = [];
  storms.forEach((s) => {
    const at = stormRowOf(renders.components, s);
    if (at) stormAt.set(`${at.row}|${at.library ?? ''}`, s);
    else missing.push(s);
  });
  const rows = renders.components.flatMap((c, i): Ranked[] => {
    const target = { component: c.name, ...(c.renderedAt && { location: c.renderedAt }) };
    const storm = stormAt.get(`${i}|`);
    const own =
      storm || c.avoidable > 0
        ? [
            renderFinding(
              storm ? 'high' : 'medium',
              target,
              {
                renders: c.renders,
                avoidable: c.avoidable,
                avoidableMs: c.time?.avoidableMs,
                totalMs: c.time?.totalMs,
                storm: storm?.recent,
              },
              `renders.components[${i}]`,
              c.advice[0],
            ),
          ]
        : [];
    // 이 행에 접힌 라이브러리 컴포넌트의 폭주. 고칠 곳은 그것을 그린 이 앱 컴포넌트다.
    const libraries = (c.libraries ?? []).flatMap((l, j) => {
      const s = stormAt.get(`${i}|${j}`);
      return s
        ? [
            renderFinding(
              'high',
              { ...target, library: `${l.package} ${l.name}` },
              { renders: l.renders, avoidable: l.avoidable, storm: s.recent },
              `renders.components[${i}].libraries[${j}]`,
            ),
          ]
        : [];
    });
    return [...own, ...libraries, ...remountFinding(c, i, target)];
  });
  // 폭주 중인데 보고서 구간·상위 행에 없는 그룹도 배지가 세므로 상세 경로 없이 남긴다.
  const rest = missing.map((s) => renderFinding('high', stormTarget(s), { renders: s.recent, avoidable: 0, storm: s.recent }));
  return [...rows, ...rest];
};

const LAYOUT_SHIFT_FIX =
  'Reserve the space before the data arrives: give the loading skeleton the final size, set min-height on the container, and set width/height (or aspect-ratio) on images.';

/**
 * 같은 컴포넌트·위치·원인 요청의 이동 점수를 합쳐(보고서에 싣기 전 전부로), 합이 LARGE_LAYOUT_SHIFT 이상인 것만 올린다.
 * 밀린 컴포넌트도 원인 요청도 모르는 이동은 고칠 곳이 없어 올리지 않는다. moved 는 올린 것 중 밀린 컴포넌트(이름·위치)의 수다.
 */
const layoutShiftFindings = (rows: readonly LayoutShiftRow[]): { findings: Ranked[]; moved: number } => {
  const groups = new Map<string, { first: number; rows: LayoutShiftRow[] }>();
  rows.forEach((r, i) => {
    const key = `${r.component ?? ''}|${r.renderedAt ?? ''}|${r.cause?.endpoint ?? ''}`;
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { first: i, rows: [r] });
  });
  const moved = new Set<string>();
  const findings = Array.from(groups.values()).flatMap(({ first, rows: list }): Ranked[] => {
    const score = round3(list.reduce((n, r) => n + r.value, 0));
    const { component, renderedAt, cause } = list[0];
    if (score < LARGE_LAYOUT_SHIFT || (!component && !cause)) return [];
    if (component) moved.add(`${component}|${renderedAt ?? ''}`);
    // 고칠 곳은 대개 응답을 받아 그리는 컴포넌트다(자리를 예약할 곳).
    const location = cause?.renderedAt ?? renderedAt;
    return [
      {
        kind: 'layout-shift',
        severity: 'medium',
        target: {
          ...(cause && { endpoint: cause.endpoint }),
          ...((cause?.component ?? component) && { component: cause?.component ?? component }),
          ...(location && { location }),
        },
        evidence: { shifts: list.length, score, ...(cause?.inferred && { inferredCause: 1 }) },
        fix: LAYOUT_SHIFT_FIX,
        // 보고서에 싣는 앞 MAX_LAYOUT_SHIFT_ROWS 개 안에 있을 때만 상세 경로가 있다.
        ...(first < MAX_LAYOUT_SHIFT_ROWS && { detail: `layoutShifts[${first}]` }),
        rank: [score * 1000, 0, list.length],
      },
    ];
  });
  return { findings, moved: moved.size };
};

const byRank = (a: Ranked, b: Ranked): number =>
  (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  b.rank[0] - a.rank[0] ||
  b.rank[1] - a.rank[1] ||
  b.rank[2] - a.rank[2];

const plural = (n: number, word: string, more = false): string => `${n}${more ? '+' : ''} ${word}${n === 1 && !more ? '' : 's'}`;

/**
 * 이미 만든 섹션에서 고칠 것을 순위대로 뽑는다. 새로 분석하지 않는다.
 * storms 는 배지와 같은 기준(`findRenderStorms`)으로 찾은 렌더 폭주 그룹이고, 배지 수도 배지와 같은 함수(`countProblems`)로 센다.
 */
export const buildSummary = (
  requests: RequestSection,
  reactQuery: ReactQuerySection,
  renders: RenderSection,
  storms: ReadonlyMap<string, RenderStorm>,
  layoutShifts: readonly LayoutShiftRow[] = [],
): ReportSummary => {
  const problems = countProblems(requests.endpoints, storms);
  const shifts = layoutShiftFindings(layoutShifts);
  const all = [
    ...requestFindings(requests.endpoints, new Set(problems.wasteEndpoints)),
    ...reactQueryFindings(reactQuery),
    ...renderFindings(renders, storms),
    ...shifts.findings,
  ].sort(byRank);
  const wastedRequests = problems.wasteEndpoints.reduce((n, e) => n + e.duplicates + e.sameResponses, 0);
  const avoidable = renders.components.filter((c) => c.avoidable > 0);
  // 렌더 행은 줄일 수 있는 렌더가 많은 순으로 상한까지만 싣는다. 마지막 행까지 줄일 수 있는 렌더가 있으면 더 있을 수 있다.
  const capped = renders.components.length >= MAX_RENDER_GROUPS && (renders.components.at(-1)?.avoidable ?? 0) > 0;
  const avoidableRenders = avoidable.reduce((n, c) => n + c.avoidable, 0);
  const avoidableMs = round1(avoidable.reduce((n, c) => n + (c.time?.avoidableMs ?? 0), 0));
  const rqCount = reactQuery.findings.filter((f) => !NOTHING_TO_FIX.has(f.kind)).length;
  const ms = avoidableMs > 0 ? `, ${avoidableMs}${capped ? '+' : ''}ms` : '';
  const verdict = [
    `${plural(problems.wasteEndpoints.length, 'endpoint')} with wasted requests (${plural(wastedRequests, 'request')})`,
    `${plural(avoidable.length, 'component', capped)} with avoidable renders (${plural(avoidableRenders, 'render', capped)}${ms})`,
    plural(rqCount, 'React Query finding'),
    // 큰 레이아웃 이동으로 밀린 컴포넌트(이름·위치)가 있을 때만 붙인다(지원하지 않는 브라우저와 이동이 없는 화면의 판정은 그대로다).
    ...(shifts.moved > 0 ? [`${plural(shifts.moved, 'component')} moved by large layout shifts`] : []),
    `RDX badge ${problems.issues}${renders.monitoring ? '' : ' (render monitoring was off)'}`,
  ].join(', ');
  return {
    verdict,
    badge: { issues: problems.issues, wasteEndpoints: problems.wasteEndpoints.length, stormingComponents: storms.size },
    topFindings: all.slice(0, MAX_TOP_FINDINGS).map(({ rank: _rank, ...f }) => f),
    omitted: Math.max(0, all.length - MAX_TOP_FINDINGS),
  };
};

/** summary 를 먼저 읽으라는 줄. buildReport 가 howToRead 맨 앞에 둔다. 폭주 기준은 배지가 쓰는 상수로 만든다. */
export const SUMMARY_HOW_TO_READ: readonly string[] = [
  'Read summary first. summary.verdict is a one-line count of the problems (a + after a number means the render rows hit their limit and there may be more); summary.topFindings lists up to 10 things to fix, in the order to fix them, and summary.omitted is how many more were left out.',
  `topFindings[].severity high means the RDX button badge counts it (an endpoint with wasted requests, or a component group — name and JSX location — with an instance rendering ${RENDER_STORM}+ times within the last ${WINDOW_MS / 1000}s; the same rule and count as summary.badge); medium means it can be reduced but the badge does not count it. Within a severity, requests come first, then React Query, renders, layout shifts (a component whose shifts add up to a score of ${LARGE_LAYOUT_SHIFT}+, largest evidence.score first), and remounts; within each, the largest estimated savings (requests or renders saved, then ms) comes first.`,
  'topFindings[].detail is the path of the full entry in this report (e.g. requests.endpoints[0], or renders.components[2].libraries[0] for a library component folded into the app component that renders it); read it and confirm in code before fixing. target.location is the listed caller that sent the most wasted requests, the JSX location (renderedAt), or the call site (stack); it is absent when unknown. savings is an estimate (ms values are dev-build sums).',
];
