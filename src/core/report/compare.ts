import { formatTime } from '../../shared/format.js';
import type { RdxReport } from './buildReport.js';

/** 비교에 쓰는 부분만 담은 보고서. sessionStorage 에 남기는 것도 이 크기다. */
export interface ComparableReport {
  /** 마지막 reset 시각(ms). null 이거나 없으면 reset 하지 않고 잰 것이다(이 필드 전에 저장한 스냅샷에는 없다). */
  resetAt?: number | null;
  /** 분석이 다 끝난 보고서인지(RdxReport.complete)와 그렇지 않은 이유. 이 필드 전에 저장한 스냅샷에는 없다 */
  complete?: boolean;
  incompleteReasons?: string[];
  requests: { endpoints: Array<{ endpoint: string; count: number; duplicates: number; sameResponses: number }> };
  renders: {
    monitoring: boolean;
    windowSeconds: number;
    components: Array<{ name: string; renders: number; avoidable: number; renderedAt?: string; package?: string }>;
  };
  reactQuery: { findings: Array<{ kind: string; keys: string[] }> };
}

/** 보고서에서 compare 가 읽는 값만 남긴다. */
export const toComparable = (r: RdxReport): ComparableReport => ({
  resetAt: r.resetAt,
  complete: r.complete,
  incompleteReasons: r.incompleteReasons,
  requests: {
    endpoints: r.requests.endpoints.map(({ endpoint, count, duplicates, sameResponses }) => ({
      endpoint,
      count,
      duplicates,
      sameResponses,
    })),
  },
  renders: {
    monitoring: r.renders.monitoring,
    windowSeconds: r.renders.windowSeconds,
    components: r.renders.components.map(({ name, renders, avoidable, renderedAt, package: pkg }) => ({
      name,
      renders,
      avoidable,
      renderedAt,
      package: pkg,
    })),
  },
  reactQuery: { findings: r.reactQuery.findings.map(({ kind, keys }) => ({ kind, keys })) },
});

type Status = 'added' | 'removed';

/** 0 이 아닌 증감만 담는다(b - a). 한쪽에만 있는 항목은 status 로 가른다. */
export type Delta<K extends string, N extends string> = { status?: Status } & { [P in K]: string } & { [P in N]?: number };

export interface ReportComparison {
  requests: Array<Delta<'endpoint', 'count' | 'duplicates' | 'sameResponses'>>;
  /** 같은 이름이라도 renderedAt·package 가 다르면 다른 행이다 */
  renders: Array<Delta<'name', 'renders' | 'avoidable'> & { renderedAt?: string; package?: string }>;
  reactQuery: { added: string[]; resolved: string[] };
  /** 두 보고서를 같은 조건으로 잰 것인지 믿기 어려운 사유 */
  warnings: string[];
}

const diffBy = <T, K extends string, N extends string>(
  a: readonly T[],
  b: readonly T[],
  keyName: K,
  idOf: (t: T) => string,
  numbers: readonly N[],
  valueOf: (t: T, n: N) => number,
  nameOf: (t: T) => string = idOf,
  extraOf: (t: T) => Record<string, string | undefined> = () => ({}),
): Array<Delta<K, N>> => {
  const before = new Map(a.map((t) => [idOf(t), t]));
  const after = new Map(b.map((t) => [idOf(t), t]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const out: Array<Delta<K, N>> = [];
  ids.forEach((id) => {
    const x = before.get(id);
    const y = after.get(id);
    const row = { [keyName]: nameOf((y ?? x)!) } as Delta<K, N>;
    if (!x) row.status = 'added';
    else if (!y) row.status = 'removed';
    numbers.forEach((n) => {
      const d = (y ? valueOf(y, n) : 0) - (x ? valueOf(x, n) : 0);
      if (d !== 0) (row as Record<string, unknown>)[n] = d;
    });
    if (Object.keys(row).length > 1) {
      Object.entries(extraOf((y ?? x)!)).forEach(([k, v]) => v !== undefined && ((row as Record<string, unknown>)[k] = v));
      out.push(row);
    }
  });
  return out;
};

/**
 * 한 보고서는 `POST /graphql` 한 줄인데 다른 보고서는 `POST /graphql (GetUser)` 처럼 나뉘어 있으면 엔드포인트 이름 규칙이
 * 바뀐 것이다(rdx 버전 차이). 그대로 두면 removed·added 로만 보여 줄어든 것처럼 읽힌다.
 */
const endpointNames = (r: ComparableReport): Set<string> => new Set(r.requests.endpoints.map((e) => e.endpoint));

const hasVariant = (names: Set<string>, endpoint: string): boolean => [...names].some((n) => n.startsWith(`${endpoint} (`));

/**
 * bare 에만 있는 엔드포인트 중 other 에서는 괄호 접미사로 나뉜 것. bare 쪽에도 나뉜 줄이 있으면 같은 규칙으로 잰 것이다
 * (이름 없는 연산만 접미사 없이 남는다).
 */
const splitIn = (bare: Set<string>, other: Set<string>): string[] =>
  [...bare].filter((e) => !other.has(e) && !hasVariant(bare, e) && hasVariant(other, e));

const splitEndpoints = (a: ComparableReport, b: ComparableReport): string[] => {
  const [x, y] = [endpointNames(a), endpointNames(b)];
  return [...new Set([...splitIn(x, y), ...splitIn(y, x)])];
};

const findingId = (f: ComparableReport['reactQuery']['findings'][number]): string => `${f.kind} ${f.keys.join(', ')}`;

/** 저장한 두 보고서(a: 전, b: 후)의 차이. 양수는 b 에서 늘어난 것이다. */
export const compare = (a: ComparableReport, b: ComparableReport): ReportComparison => {
  const warnings: string[] = [];
  if (a.renders.windowSeconds !== b.renders.windowSeconds) {
    warnings.push(`measurement windows differ (${a.renders.windowSeconds}s / ${b.renders.windowSeconds}s)`);
  }
  if (!a.renders.monitoring || !b.renders.monitoring)
    warnings.push('render monitoring was off in one of the reports; render comparison may be unreliable');
  // 한쪽만 reset 뒤에 쟀으면 측정 조건이 달라 증감을 믿기 어렵다.
  const ra = a.resetAt ?? null;
  const rb = b.resetAt ?? null;
  if ((ra === null) !== (rb === null)) {
    const beforeStr = ra !== null ? formatTime(ra) : 'none';
    const afterStr = rb !== null ? formatTime(rb) : 'none';
    warnings.push(`only one report was measured after a reset (before: ${beforeStr}, after: ${afterStr})`);
  }
  // snapshot 은 큐를 비우고 소스맵을 2초까지 기다리지만, 그 안에 끝나지 않으면 덜 분석된 채 남는다.
  const incompleteOf = (name: string, r: ComparableReport): string[] =>
    r.complete === false ? [`${name} (${(r.incompleteReasons ?? []).join(', ') || 'unknown'})`] : [];
  const incomplete = [...incompleteOf('before', a), ...incompleteOf('after', b)];
  if (incomplete.length > 0)
    warnings.push(
      `saved before analysis finished (complete: false): ${incomplete.join('; ')}; callers and counts may differ for that reason`,
    );
  splitEndpoints(a, b).forEach((e) =>
    warnings.push(`endpoint naming changed for ${e} (one report splits it into "${e} (…)" rows; likely different rdx versions)`),
  );
  const before = new Set(a.reactQuery.findings.map(findingId));
  const after = new Set(b.reactQuery.findings.map(findingId));
  return {
    requests: diffBy(
      a.requests.endpoints,
      b.requests.endpoints,
      'endpoint',
      (e) => e.endpoint,
      ['count', 'duplicates', 'sameResponses'],
      (e, n) => e[n],
    ),
    renders: diffBy(
      a.renders.components,
      b.renders.components,
      'name',
      // 같은 이름의 위치별·패키지별 행을 한 행으로 합치지 않는다.
      (c) => JSON.stringify([c.name, c.renderedAt, c.package]),
      ['renders', 'avoidable'],
      (c, n) => c[n],
      (c) => c.name,
      (c) => ({ renderedAt: c.renderedAt, package: c.package }),
    ),
    reactQuery: { added: [...after].filter((id) => !before.has(id)), resolved: [...before].filter((id) => !after.has(id)) },
    warnings,
  };
};
