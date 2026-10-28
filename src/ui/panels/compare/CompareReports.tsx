import { useMemo, useState } from 'react';

import { compare } from '../../../core/report/compare.js';
import { getSnapshot, snapshotNames } from '../../../core/report/reportApi.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';

const REQUEST_LABELS: ReadonlySet<string> = new Set(['endpoint', 'status']);
const RENDER_LABELS: ReadonlySet<string> = new Set(['name', 'status', 'renderedAt', 'package']);

const fmt = (row: Record<string, unknown>, skip: ReadonlySet<string>): string =>
  Object.entries(row)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k} ${typeof v === 'number' && v > 0 ? '+' : ''}${String(v)}`)
    .join(' · ');

/** 저장한 스냅샷 둘(전, 후)을 골라 증감을 보인다. */
export const CompareReports = () => {
  const [open, setOpen] = useState(false);
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
      <Button active={open} onClick={() => setOpen(!open)} title="snapshot 으로 저장한 두 보고서를 비교합니다">
        비교
      </Button>
      {open && (
        <div style={{ flexBasis: '100%' }}>
          {names.length < 2 ? (
            <Muted>window.__RDX__.snapshot(이름) 으로 보고서를 둘 이상 저장하면 비교할 수 있습니다.</Muted>
          ) : (
            <>
              {pick(before, setBefore, '전')} → {pick(after, setAfter, '후')}
            </>
          )}
          {result && (
            <div>
              {result.warnings.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
              {result.requests.map((r) => (
                <div key={r.endpoint}>
                  {r.endpoint} {r.status ?? ''} {fmt(r, REQUEST_LABELS)}
                </div>
              ))}
              {result.renders.map((r) => (
                <div key={`${r.name}|${r.renderedAt ?? ''}|${r.package ?? ''}`}>
                  &lt;{r.name}&gt; {r.renderedAt ?? r.package ?? ''} {r.status ?? ''} {fmt(r, RENDER_LABELS)}
                </div>
              ))}
              {result.reactQuery.added.map((id) => (
                <div key={`+${id}`}>React Query 새 지적: {id}</div>
              ))}
              {result.reactQuery.resolved.map((id) => (
                <div key={`-${id}`}>React Query 해결: {id}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};
