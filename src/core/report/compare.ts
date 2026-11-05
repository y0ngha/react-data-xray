import { formatTime, round1 } from '../../shared/format.js';
import type { EffectiveConfig } from '../config.js';
import type { RdxReport } from './buildReport.js';
import { componentIdOf, endpointId } from '../../shared/ids.js';
import { MAX_FETCH_CAUSES } from './reactQuerySection.js';
import { MAX_RENDER_GROUPS, tallyOf, type RenderRowTally, type RenderSection } from './renderSection.js';

/** 비교에 쓰는 부분만 담은 보고서. sessionStorage 에 남기는 것도 이 크기다. */
export interface ComparableReport {
  /** 마지막 reset 시각(ms). null 이거나 없으면 reset 하지 않고 잰 것이다(이 필드 전에 저장한 스냅샷에는 없다). */
  resetAt?: number | null;
  /** 분석이 다 끝난 보고서인지(RdxReport.complete)와 그렇지 않은 이유. 이 필드 전에 저장한 스냅샷에는 없다 */
  complete?: boolean;
  incompleteReasons?: string[];
  /** 잰 때의 판정 기준(이 필드 전에 저장한 스냅샷에는 없다) */
  config?: EffectiveConfig;
  /** 잰 화면의 경로(이 필드 전에 저장한 스냅샷에는 없다) */
  page?: string;
  requests: {
    /** 기록 상한을 넘어 버린 요청 수(이 필드 전에 저장한 스냅샷에는 없다) */
    dropped?: number;
    endpoints: Array<{
      endpoint: string;
      count: number;
      duplicates: number;
      sameResponses: number;
      /** 이 두 필드 전에 저장한 스냅샷에는 없다 */
      failedDuplicates?: number;
      review?: number;
    }>;
  };
  renders: {
    monitoring: boolean;
    windowSeconds: number;
    /** 인스턴스 상한으로 렌더 적은 인스턴스를 뺐는지와 그 수(이 필드 전에 저장한 스냅샷에는 없다) */
    truncated?: boolean;
    droppedInstances?: number;
    /**
     * components 에 담지 못한 행 수와 그 합. 보고서보다 많은 행(MAX_COMPARABLE_RENDER_ROWS)을 담으므로 대개 0 이다.
     * 이 필드 전에 저장한 스냅샷에는 없고, 그때 components 가 MAX_RENDER_GROUPS 행이면 더 있었을 수 있다
     */
    omitted?: RenderSection['omitted'];
    components: RenderRowTally[];
  };
  reactQuery: {
    findings: Array<{ kind: string; keys: string[] }>;
    /** 보고서 fetchCauses 를 원인별 수로 줄인 것. wasteful 은 같은 응답을 낭비로 다시 받은 묶음(이 필드 전에 저장한 스냅샷에는 없다) */
    fetchCauses?: Array<{ queryKey: string; observer?: string; cause: string; count: number; wasteful?: true }>;
    /** 보고서 fetchCauses 상한 밖으로 빠진 묶음 수(이 필드 전에 저장한 스냅샷·보고서에는 없다) */
    fetchCausesOmitted?: number;
  };
}

const sum = <T>(list: readonly T[], of: (t: T) => number): number => list.reduce((n, t) => n + of(t), 0);

/** 보고서 상한 밖 합에서 따로 담은 행을 뺀 나머지. 상한 밖 행을 다 담았으면 0 이다. */
const remainingOmitted = (
  omitted: RenderSection['omitted'] | undefined,
  extra: readonly RenderRowTally[],
): RenderSection['omitted'] | undefined => {
  if (!omitted) return undefined;
  const ms = omitted.totalMs === undefined ? undefined : round1(omitted.totalMs - sum(extra, (c) => c.totalMs ?? 0));
  return {
    components: omitted.components - extra.length,
    renders: omitted.renders - sum(extra, (c) => c.renders),
    avoidable: omitted.avoidable - sum(extra, (c) => c.avoidable),
    ...(ms !== undefined && { totalMs: Math.max(0, ms) }),
  };
};

/**
 * 보고서에서 compare 가 읽는 값만 남긴다. beyondCap 은 그 보고서를 만들 때 함께 만든 상한(MAX_RENDER_GROUPS) 밖 렌더 행이다
 * (buildSnapshotReport). 그래야 고친 뒤 순위가 밀린 컴포넌트를 사라진 것(removed)으로 보지 않는다. 파일에서 읽은 보고서는
 * 보고서에 있는 행만 담는다.
 */
export const toComparable = (r: RdxReport, beyondCap: readonly RenderRowTally[] = []): ComparableReport => {
  const extra = beyondCap;
  return {
    resetAt: r.resetAt,
    complete: r.complete,
    incompleteReasons: r.incompleteReasons,
    config: r.config,
    page: r.page,
    requests: {
      dropped: r.requests.dropped,
      endpoints: r.requests.endpoints.map(({ endpoint, count, duplicates, sameResponses, failedDuplicates, review }) => ({
        endpoint,
        count,
        duplicates,
        sameResponses,
        failedDuplicates,
        review,
      })),
    },
    renders: {
      monitoring: r.renders.monitoring,
      windowSeconds: r.renders.windowSeconds,
      truncated: r.renders.truncated,
      droppedInstances: r.renders.droppedInstances,
      omitted: remainingOmitted(r.renders.omitted, extra),
      components: [...r.renders.components.map(tallyOf), ...extra],
    },
    reactQuery: {
      findings: r.reactQuery.findings.map(({ kind, keys }) => ({ kind, keys })),
      fetchCauses: (r.reactQuery.fetchCauses ?? []).map(({ queryKey, observer, cause, count, fix }) => ({
        queryKey,
        observer,
        cause,
        count,
        // 낭비가 아니면 undefined 로 두어 JSON(스냅샷)에서 빠진다.
        wasteful: fix === undefined ? undefined : (true as const),
      })),
      fetchCausesOmitted: r.reactQuery.fetchCausesOmitted,
    },
  };
};

/** added·removed: 한쪽에만 있다. unknown: 한쪽의 행 상한 밖으로 빠졌을 수 있어 그쪽 값을 모른다 */
export type Status = 'added' | 'removed' | 'unknown';

/**
 * 행·합계의 판정. 양쪽에 있는 행은 낭비(요청은 duplicates + sameResponses, 렌더는 avoidable, fetch 원인은 낭비 묶음의 count)가
 * 줄면 improved, 늘면 regressed 이고, 낭비가 같으면 전체 수(count·renders)로 가른다.
 * 한쪽에만 있는 행은 0 과 견주지 않고 new·gone 으로 둔다. 다만 낭비가 있는 새 행은 regressed, 낭비가 있던 사라진 행은 improved.
 * 한쪽 값을 모르면 unknown.
 */
export type Verdict = 'improved' | 'regressed' | 'unchanged' | 'new' | 'gone' | 'unknown';

/**
 * 0 이 아닌 증감만 담는다(b - a). 한쪽에만 있는 항목은 status 로 가른다. status 가 unknown 이면 증감 대신 아는 쪽 값을
 * before 또는 after 에 담는다.
 */
export type Delta<K extends string, N extends string> = { status?: Status; verdict: Verdict } & { [P in K]: string } & {
  [P in N]?: number;
} & { before?: Partial<Record<N, number>>; after?: Partial<Record<N, number>> };

/**
 * 두 보고서의 합. 렌더 합은 한쪽이라도 상한 밖 합을 모르면(상한만큼 찬 옛 스냅샷), 요청 합은 한쪽이라도 기록 상한으로 버린
 * 요청이 있으면 verdict 가 unknown 이고 그 값은 하한이다
 */
export interface Total {
  before: number;
  after: number;
  delta: number;
  verdict: Verdict;
}

export interface ReportComparison {
  /** 요청 수·낭비 요청·렌더·줄일 수 있는 렌더의 합(렌더는 상한 밖 행까지). renderMs 는 양쪽에 시간 기록이 있을 때만(dev 빌드 값이라 흔들린다) */
  totals: {
    requests: Total;
    wastedRequests: Total;
    renders: Total;
    avoidable: Total;
    renderMs?: Omit<Total, 'verdict'>;
  };
  /** id 는 보고서의 requests.endpoints[].id 와 같다(옛 스냅샷에는 없어 비교할 때 만든다) */
  requests: Array<Delta<'endpoint', 'count' | 'duplicates' | 'sameResponses' | 'failedDuplicates' | 'review'> & { id: string }>;
  /**
   * 같은 이름이라도 renderedAt·package(와 그린 앱 컴포넌트)가 다르면 다른 행이다. id 는 renders.components[].id 와 같다.
   * totalMs 증감은 렌더 수가 달라진 행에만 싣는다
   */
  renders: Array<
    Delta<'name', 'renders' | 'avoidable' | 'totalMs'> & {
      id: string;
      renderedAt?: string;
      /** JSX 줄만 옮겨져 위치가 달라진 행을 한 행으로 맞췄을 때, 전 보고서의 위치(#129) */
      renderedAtBefore?: string;
      package?: string;
    }
  >;
  reactQuery: {
    added: string[];
    resolved: string[];
    /** queryKey·관찰자·원인·낭비 여부별 fetch 수의 증감 */
    fetchCauses: Array<Delta<'queryKey', 'count'> & { observer?: string; cause?: string; wasteful?: true }>;
  };
  /** 두 보고서를 같은 조건으로 잰 것인지 믿기 어려운 사유 */
  warnings: string[];
}

interface DiffSpec<T, K extends string, N extends string> {
  keyName: K;
  idOf: (t: T) => string;
  nameOf: (t: T) => string;
  /** 증감을 싣는 값. 이 중 하나라도 다르면 행을 싣는다 */
  numbers: readonly N[];
  /** 증감은 싣지만 그것만 달라서는 행을 싣지 않는 값(렌더 시간처럼 늘 조금씩 흔들리는 값) */
  info?: readonly N[];
  valueOf: (t: T, n: N) => number | undefined;
  /** 판정에 쓰는 값을 앞의 것부터(줄수록 나아진 것). 첫 값이 낭비다 */
  rankOf: (t: T) => number[];
  extraOf?: (t: T) => Record<string, string | true | undefined>;
  /** 한쪽(전, 후)에 없는 행이 그쪽 행 상한 밖에 있었을 수 있는지 */
  mayHide: readonly [boolean, boolean];
}

const verdictOf = (before: readonly number[], after: readonly number[]): Verdict => {
  const i = before.findIndex((v, k) => v !== after[k]);
  if (i < 0) return 'unchanged';
  return after[i] < before[i] ? 'improved' : 'regressed';
};

const valuesOf = <T, K extends string, N extends string>(t: T, spec: DiffSpec<T, K, N>): Partial<Record<N, number>> =>
  Object.fromEntries(
    [...spec.numbers, ...(spec.info ?? [])].flatMap((n) => {
      const v = spec.valueOf(t, n);
      return v === undefined ? [] : [[n, v]];
    }),
  ) as Partial<Record<N, number>>;

const diffBy = <T, K extends string, N extends string>(a: readonly T[], b: readonly T[], spec: DiffSpec<T, K, N>): Array<Delta<K, N>> => {
  const before = new Map(a.map((t) => [spec.idOf(t), t]));
  const after = new Map(b.map((t) => [spec.idOf(t), t]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  return ids.flatMap((id) => {
    const x = before.get(id);
    const y = after.get(id);
    const known = (y ?? x)!;
    const row = { [spec.keyName]: spec.nameOf(known) } as Record<string, unknown>;
    const done = (): Array<Delta<K, N>> => {
      Object.entries(spec.extraOf?.(known) ?? {}).forEach(([k, v]) => v !== undefined && (row[k] = v));
      return [row as Delta<K, N>];
    };
    // 한쪽에 없지만 그쪽 상한 밖에 있었을 수 있으면 증감을 지어내지 않는다(없는 쪽을 0 으로 보면 가짜 개선·악화가 된다).
    if ((!x && spec.mayHide[0]) || (!y && spec.mayHide[1])) {
      row.status = 'unknown';
      row.verdict = 'unknown';
      row[x ? 'before' : 'after'] = valuesOf(known, spec);
      return done();
    }
    if (!x) row.status = 'added';
    else if (!y) row.status = 'removed';
    // 있는 쪽에 값이 없으면(그 필드 전에 저장한 스냅샷, 시간을 재지 못한 빌드) 그 값의 증감을 만들지 않는다.
    const deltaOf = (n: N): number | undefined => {
      const [vx, vy] = [x && spec.valueOf(x, n), y && spec.valueOf(y, n)];
      if ((x && vx === undefined) || (y && vy === undefined)) return undefined;
      const d = round1((vy ?? 0) - (vx ?? 0));
      if (d !== 0) row[n] = d;
      return d;
    };
    const changed = spec.numbers.filter((n) => (deltaOf(n) ?? 0) !== 0);
    if (!row.status && changed.length === 0) return [];
    (spec.info ?? []).forEach(deltaOf);
    if (x && y) row.verdict = verdictOf(spec.rankOf(x), spec.rankOf(y));
    // 한쪽에만 있는 행은 없는 쪽을 0 으로 보고 판정하지 않는다. 낭비가 있을 때만 그것이 생기거나 없어진 것으로 본다.
    else if (y) row.verdict = spec.rankOf(y)[0] > 0 ? 'regressed' : 'new';
    else row.verdict = spec.rankOf(x!)[0] > 0 ? 'improved' : 'gone';
    return done();
  });
};

/** omitted 를 남기기 전의 옛 스냅샷이 보고서 상한만큼 찼다. 빠진 행이 있었는지도, 그 합도 모른다 */
const oldSnapshotFilledCap = (r: ComparableReport): boolean =>
  r.renders.omitted === undefined && r.renders.components.length >= MAX_RENDER_GROUPS;

/** 렌더 행이 상한 밖으로 빠졌을 수 있는지 */
const rendersMayHide = (r: ComparableReport): boolean => (r.renders.omitted ? r.renders.omitted.components > 0 : oldSnapshotFilledCap(r));

/** fetch 원인 묶음이 상한 밖으로 빠졌을 수 있는지. fetchCausesOmitted 가 없으면(옛 보고서) 상한만큼 찼을 때 그렇다고 본다 */
const fetchCausesMayHide = (r: ComparableReport): boolean =>
  r.reactQuery.fetchCausesOmitted === undefined
    ? (r.reactQuery.fetchCauses?.length ?? 0) >= MAX_FETCH_CAUSES
    : r.reactQuery.fetchCausesOmitted > 0;

/** 기록 상한(maxRecords)으로 요청을 버렸다. 요청 합이 하한이다 */
const droppedRequests = (r: ComparableReport): boolean => (r.requests.dropped ?? 0) > 0;

const total = (before: number, after: number, known = true): Total => ({
  before: round1(before),
  after: round1(after),
  delta: round1(after - before),
  verdict: known ? verdictOf([before], [after]) : 'unknown',
});

type EndpointRow = ComparableReport['requests']['endpoints'][number];
const wasteOf = (e: EndpointRow): number => e.duplicates + e.sameResponses;

const renderSum = (r: ComparableReport, field: 'renders' | 'avoidable'): number =>
  sum(r.renders.components, (c) => c[field]) + (r.renders.omitted?.[field] ?? 0);

const renderMsOf = (r: ComparableReport): number | undefined =>
  r.renders.components.some((c) => c.totalMs !== undefined)
    ? sum(r.renders.components, (c) => c.totalMs ?? 0) + (r.renders.omitted?.totalMs ?? 0)
    : undefined;

const totalsOf = (a: ComparableReport, b: ComparableReport): ReportComparison['totals'] => {
  // 합이 하한일 뿐인 쪽이 있으면 판정하지 않는다.
  const rendersKnown = !oldSnapshotFilledCap(a) && !oldSnapshotFilledCap(b);
  const requestsKnown = !droppedRequests(a) && !droppedRequests(b);
  const [msA, msB] = [renderMsOf(a), renderMsOf(b)];
  return {
    requests: total(
      sum(a.requests.endpoints, (e) => e.count),
      sum(b.requests.endpoints, (e) => e.count),
      requestsKnown,
    ),
    wastedRequests: total(sum(a.requests.endpoints, wasteOf), sum(b.requests.endpoints, wasteOf), requestsKnown),
    renders: total(renderSum(a, 'renders'), renderSum(b, 'renders'), rendersKnown),
    avoidable: total(renderSum(a, 'avoidable'), renderSum(b, 'avoidable'), rendersKnown),
    ...(msA !== undefined && msB !== undefined && { renderMs: { before: round1(msA), after: round1(msB), delta: round1(msB - msA) } }),
  };
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

// 판정 기준만 본다. 기준이 다르면 중복·같은 응답 수가 달라진다. reportPath 는 보내는 곳일 뿐이라 보지 않는다.
const CRITERIA = ['dedupeWindowMs', 'burst', 'nPlusOne', 'keyHeaders'] as const;

const sortedText = (values: readonly string[]): string => JSON.stringify([...values].sort());

/**
 * 두 설정에서 판정 기준이 다른 항목("dedupeWindowMs 2000 / 1000"). 무시 목록은 순서와 무관한 집합으로 코드·패널을 따로 본다.
 * 기억할 요청 수는 어느 한쪽에서라도 넘쳐 버린 요청이 있을 때만 결과를 바꾸므로 그때만 본다.
 * 한쪽이라도 설정을 남기지 않은 옛 보고서면 비교하지 않는다.
 */
const configDifferences = (a: ComparableReport, b: ComparableReport): string[] => {
  const [x, y] = [a.config, b.config];
  if (!x || !y) return [];
  // nPlusOne(#85)처럼 나중에 더한 기준은 그 전에 저장한 보고서에 없다. 한쪽에 없으면 그 기준은 비교하지 않는다.
  const rows: Array<[string, string, string]> = CRITERIA.filter((key) => x[key] !== undefined && y[key] !== undefined).map((key) => [
    key,
    JSON.stringify(x[key]),
    JSON.stringify(y[key]),
  ]);
  rows.push(['ignore (code)', sortedText(x.ignore.code), sortedText(y.ignore.code)]);
  rows.push(['ignore (panel)', sortedText(x.ignore.panel), sortedText(y.ignore.panel)]);
  if ((a.requests.dropped ?? 0) > 0 || (b.requests.dropped ?? 0) > 0)
    rows.push(['maxRecords', JSON.stringify(x.maxRecords), JSON.stringify(y.maxRecords)]);
  return rows.filter(([, before, after]) => before !== after).map(([key, before, after]) => `${key} ${before} / ${after}`);
};

const findingId = (f: ComparableReport['reactQuery']['findings'][number]): string => `${f.kind} ${f.keys.join(', ')}`;

type FetchCauseRow = NonNullable<ComparableReport['reactQuery']['fetchCauses']>[number];

const fetchCauseDiff = (a: ComparableReport, b: ComparableReport): ReportComparison['reactQuery']['fetchCauses'] => {
  const [x, y] = [a.reactQuery.fetchCauses, b.reactQuery.fetchCauses];
  // 이 필드 전에 저장한 스냅샷과는 비교하지 않는다(없던 것이 모두 added 로 보인다).
  if (!x || !y) return [];
  return diffBy<FetchCauseRow, 'queryKey', 'count'>(x, y, {
    keyName: 'queryKey',
    idOf: (c) => JSON.stringify([c.queryKey, c.observer, c.cause, !!c.wasteful]),
    nameOf: (c) => c.queryKey,
    numbers: ['count'],
    valueOf: (c) => c.count,
    // 낭비 묶음(wasteful)만 낭비로 센다. 낭비가 아닌 fetch 는 전체 수로만 가른다.
    rankOf: (c) => [c.wasteful ? c.count : 0, c.count],
    extraOf: (c) => ({ observer: c.observer, cause: c.cause, wasteful: c.wasteful }),
    // 보고서는 fetch 원인을 많은 순으로 상한까지만 싣는다.
    mayHide: [fetchCausesMayHide(a), fetchCausesMayHide(b)],
  });
};

/** 렌더 행의 id. 보고서 행의 id(renders.components[].id)를 쓰고, 그 필드 전에 저장한 스냅샷은 같은 함수로 만든다 */
const rowIdOf = (c: RenderRowTally): string => c.id ?? componentIdOf({ name: c.name, location: c.renderedAt, package: c.package });

/** renderedAt 에서 끝의 :줄(:열) 을 뗀 파일 */
const fileOf = (location: string): string => location.replace(/:\d+(?::\d+)?$/, '');

/**
 * id 로 짝이 없는 렌더 행 가운데, 이름·파일·패키지가 같고 줄만 다른 행을 짝짓는다(#129). 고친 파일에서 JSX 줄이 밀리면
 * id(c:이름@파일:줄)가 바뀌어 같은 컴포넌트가 다른 행이 되기 때문이다. 같은 조합이 어느 한쪽에 둘 이상이면(한 파일의 여러
 * 위치에서 같은 컴포넌트를 그림) 어느 것이 옮겨졌는지 모르므로 짝짓지 않는다.
 * @returns 짝지은 후(after) 행 → 전(before) 행
 */
const movedRows = (a: readonly RenderRowTally[], b: readonly RenderRowTally[]): Map<RenderRowTally, RenderRowTally> => {
  const idsA = new Set(a.map(rowIdOf));
  const idsB = new Set(b.map(rowIdOf));
  const keyOf = (c: RenderRowTally): string | undefined =>
    c.renderedAt ? JSON.stringify([c.name, fileOf(c.renderedAt), c.package ?? null]) : undefined;
  const byKey = (rows: readonly RenderRowTally[], others: ReadonlySet<string>): Map<string, RenderRowTally[]> => {
    const groups = new Map<string, RenderRowTally[]>();
    rows
      .filter((c) => !others.has(rowIdOf(c)))
      .forEach((c) => {
        const key = keyOf(c);
        if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), c]);
      });
    return groups;
  };
  const before = byKey(a, idsB);
  const after = byKey(b, idsA);
  return new Map(
    [...after].flatMap(([key, ys]) => {
      const xs = before.get(key);
      return ys.length === 1 && xs?.length === 1 ? [[ys[0], xs[0]] as const] : [];
    }),
  );
};

const sidesOf = (a: boolean, b: boolean): string => (a && b ? 'both reports' : a ? 'before' : 'after');

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
  configDifferences(a, b).forEach((d) => warnings.push(`detection config differs: ${d}`));
  splitEndpoints(a, b).forEach((e) =>
    warnings.push(`endpoint naming changed for ${e} (one report splits it into "${e} (…)" rows; likely different rdx versions)`),
  );
  // 다른 화면을 잰 두 보고서의 증감은 고친 결과가 아니다. page 를 남기기 전 스냅샷과는 보지 않는다.
  if (a.page !== undefined && b.page !== undefined && a.page !== b.page)
    warnings.push(`pages differ (${a.page || '(none)'} / ${b.page || '(none)'}); the reports may measure different screens`);
  // 기록 상한으로 요청을 버린 쪽은 요청 합이 하한이라 합계 판정을 unknown 으로 둔다.
  const [da, db] = [droppedRequests(a), droppedRequests(b)];
  if (da || db)
    warnings.push(
      `requests were dropped at the record limit in ${sidesOf(da, db)} (dropped ${a.requests.dropped ?? 0} / ${b.requests.dropped ?? 0}); request totals cannot be judged`,
    );
  // 인스턴스 상한에 걸린 쪽은 렌더 적은 인스턴스를 뺐으므로 렌더 수를 그대로 견줄 수 없다.
  const [ta, tb] = [!!a.renders.truncated, !!b.renders.truncated];
  if (ta || tb)
    warnings.push(
      `render instances were truncated in ${sidesOf(ta, tb)} (droppedInstances ${a.renders.droppedInstances ?? 0} / ${b.renders.droppedInstances ?? 0}); render counts leave out the least-rendered instances`,
    );
  const moved = movedRows(a.renders.components, b.renders.components);
  const renders = diffBy(a.renders.components, b.renders.components, {
    keyName: 'name',
    // 같은 이름의 위치별·패키지별(그린 앱 컴포넌트별) 행을 한 행으로 합치지 않는다. id 를 남기기 전 스냅샷은 이름·위치·패키지로 만든다.
    // 줄만 옮겨진 행은 전 행의 id 로 맞춘다(보이는 id·위치는 후 행의 것).
    idOf: (c) => rowIdOf(moved.get(c) ?? c),
    nameOf: (c) => c.name,
    numbers: ['renders', 'avoidable'],
    info: ['totalMs'],
    valueOf: (c, n) => c[n],
    rankOf: (c) => [c.avoidable, c.renders],
    extraOf: (c) => ({ id: rowIdOf(c), renderedAt: c.renderedAt, renderedAtBefore: moved.get(c)?.renderedAt, package: c.package }),
    mayHide: [rendersMayHide(a), rendersMayHide(b)],
  });
  const fetchCauses = fetchCauseDiff(a, b);
  const unknown = [...renders, ...fetchCauses].filter((r) => r.status === 'unknown').length;
  if (unknown > 0)
    warnings.push(
      `${unknown} row(s) have status unknown: one report left them out at its row limit, so whether they changed cannot be told (their known values are in before/after)`,
    );
  const before = new Set(a.reactQuery.findings.map(findingId));
  const after = new Set(b.reactQuery.findings.map(findingId));
  return {
    totals: totalsOf(a, b),
    requests: diffBy(a.requests.endpoints, b.requests.endpoints, {
      keyName: 'endpoint',
      idOf: (e) => e.endpoint,
      nameOf: (e) => e.endpoint,
      numbers: ['count', 'duplicates', 'sameResponses', 'failedDuplicates', 'review'],
      valueOf: (e, n) => e[n],
      rankOf: (e) => [wasteOf(e), e.count],
      extraOf: (e) => ({ id: endpointId(e.endpoint) }),
      // 요청 행은 상한 없이 다 싣는다.
      mayHide: [false, false],
    }) as ReportComparison['requests'],
    renders: renders as ReportComparison['renders'],
    reactQuery: {
      added: [...after].filter((id) => !before.has(id)),
      resolved: [...before].filter((id) => !after.has(id)),
      fetchCauses,
    },
    warnings,
  };
};
