import type { RdxReport } from './buildReport.js';

type Status = 'added' | 'removed';

/** 0 이 아닌 증감만 담는다(b - a). 한쪽에만 있는 항목은 status 로 가른다. */
export type Delta<K extends string, N extends string> = { status?: Status } & { [P in K]: string } & { [P in N]?: number };

export interface ReportComparison {
  requests: Array<Delta<'endpoint', 'count' | 'duplicates' | 'sameResponses'>>;
  renders: Array<Delta<'name', 'renders' | 'avoidable'>>;
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
): Array<Delta<K, N>> => {
  const before = new Map(a.map((t) => [idOf(t), t]));
  const after = new Map(b.map((t) => [idOf(t), t]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const out: Array<Delta<K, N>> = [];
  ids.forEach((id) => {
    const x = before.get(id);
    const y = after.get(id);
    const row = { [keyName]: id } as Delta<K, N>;
    if (!x) row.status = 'added';
    else if (!y) row.status = 'removed';
    numbers.forEach((n) => {
      const d = (y ? valueOf(y, n) : 0) - (x ? valueOf(x, n) : 0);
      if (d !== 0) (row as Record<string, unknown>)[n] = d;
    });
    if (Object.keys(row).length > 1) out.push(row);
  });
  return out;
};

const findingId = (f: RdxReport['reactQuery']['findings'][number]): string => `${f.kind} ${f.keys.join(', ')}`;

/** 저장한 두 보고서(a: 전, b: 후)의 차이. 양수는 b 에서 늘어난 것이다. */
export const compare = (a: RdxReport, b: RdxReport): ReportComparison => {
  const warnings: string[] = [];
  if (a.renders.windowSeconds !== b.renders.windowSeconds) {
    warnings.push(`측정 구간이 다르다 (${a.renders.windowSeconds}초 / ${b.renders.windowSeconds}초)`);
  }
  if (!a.renders.monitoring || !b.renders.monitoring) warnings.push('렌더 감시가 꺼진 보고서가 있어 렌더 비교는 믿기 어렵다');
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
      (c) => c.name,
      ['renders', 'avoidable'],
      (c, n) => c[n],
    ),
    reactQuery: { added: [...after].filter((id) => !before.has(id)), resolved: [...before].filter((id) => !after.has(id)) },
    warnings,
  };
};
