import { useEffect, useMemo, useReducer, useState } from 'react';

import { compare, type ReportComparison, type Total } from '../../../core/report/compare.js';
import { getSnapshot, snapshotNames } from '../../../core/report/reportApi.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';
import { SNAPSHOT_SAVED_EVENT } from './SnapshotButton.js';

// 행 머리에 따로 보이는 값과, 증감이 아닌 값(unknown 행의 아는 쪽 값)은 증감 목록에서 뺀다.
const REQUEST_LABELS: ReadonlySet<string> = new Set(['endpoint', 'status', 'verdict', 'before', 'after']);
const RENDER_LABELS: ReadonlySet<string> = new Set(['name', 'status', 'verdict', 'renderedAt', 'package', 'before', 'after']);
const FETCH_LABELS: ReadonlySet<string> = new Set(['queryKey', 'observer', 'cause', 'wasteful', 'status', 'verdict', 'before', 'after']);

const signed = (v: number): string => `${v > 0 ? '+' : ''}${v}`;

const fmt = (row: Record<string, unknown>, skip: ReadonlySet<string>): string =>
  Object.entries(row)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k} ${typeof v === 'number' ? signed(v) : String(v)}`)
    .join(' · ');

// unknown 행은 증감 대신 아는 쪽 값만 있다.
const known = (row: { before?: object; after?: object }): string => {
  const [side, values] = row.before ? ['before', row.before] : row.after ? ['after', row.after] : ['', {}];
  const text = Object.entries(values)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' · ');
  return text && `(${side}: ${text})`;
};

const TOTAL_LABELS: Array<[keyof ReportComparison['totals'], string]> = [
  ['requests', 'requests'],
  ['wastedRequests', 'wasted requests'],
  ['renders', 'renders'],
  ['avoidable', 'avoidable renders'],
];

const totalText = (label: string, t: Total): string => `${label} ${t.before} → ${t.after} (${signed(t.delta)}, ${t.verdict})`;

const Totals = ({ totals }: { totals: ReportComparison['totals'] }) => (
  <div>
    {TOTAL_LABELS.map(([key, label]) => totalText(label, totals[key] as Total)).join(' · ')}
    {totals.renderMs && ` · render ms ${totals.renderMs.before} → ${totals.renderMs.after} (${signed(totals.renderMs.delta)})`}
  </div>
);

/** 저장한 스냅샷 둘(전, 후)을 골라 증감을 보인다. */
export const CompareReports = () => {
  const [open, setOpen] = useState(false);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(SNAPSHOT_SAVED_EVENT, refresh);
    return () => window.removeEventListener(SNAPSHOT_SAVED_EVENT, refresh);
  }, []);
  const names = open ? snapshotNames() : [];
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  // 닫혀 있는 동안 주기적으로 다시 그려져도 sessionStorage 의 보고서를 읽지 않는다.
  const result = useMemo(() => {
    const a = open ? getSnapshot(before) : undefined;
    const b = open ? getSnapshot(after) : undefined;
    return a && b ? compare(a, b) : null;
  }, [open, before, after]);
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      <option value="">{label}</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <Button active={open} onClick={() => setOpen(!open)} title="Compare two reports saved with snapshot">
        Compare
      </Button>
      {open && (
        <div style={{ flexBasis: '100%', order: 999 }}>
          {names.length < 2 ? (
            <Muted>Use the Save button or window.__RDX__.snapshot(name) to save two or more snapshots, then compare them here.</Muted>
          ) : (
            <>
              {pick(before, setBefore, 'before')} → {pick(after, setAfter, 'after')}
            </>
          )}
          {result && (
            <div>
              {result.warnings.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
              <Totals totals={result.totals} />
              {result.requests.map((r) => (
                <div key={r.endpoint}>
                  {r.endpoint} {r.status ?? ''} [{r.verdict}] {fmt(r, REQUEST_LABELS)}
                </div>
              ))}
              {result.renders.map((r) => (
                <div key={`${r.name}|${r.renderedAt ?? ''}|${r.package ?? ''}`}>
                  &lt;{r.name}&gt; {r.renderedAt ?? r.package ?? ''} {r.status ?? ''} [{r.verdict}] {fmt(r, RENDER_LABELS)} {known(r)}
                </div>
              ))}
              {result.reactQuery.fetchCauses.map((r) => (
                <div key={`${r.queryKey}|${r.observer ?? ''}|${r.cause ?? ''}|${r.wasteful ? 1 : 0}`}>
                  React Query fetch {r.queryKey} {r.cause ?? ''}
                  {r.wasteful ? ' (wasteful)' : ''} {r.status ?? ''} [{r.verdict}] {fmt(r, FETCH_LABELS)} {known(r)}
                </div>
              ))}
              {result.reactQuery.added.map((id) => (
                <div key={`+${id}`}>React Query new finding: {id}</div>
              ))}
              {result.reactQuery.resolved.map((id) => (
                <div key={`-${id}`}>React Query resolved: {id}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};
