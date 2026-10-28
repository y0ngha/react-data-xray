import { useState } from 'react';

import { compare } from '../../../core/report/compare.js';
import { getSnapshot, snapshotNames } from '../../../core/report/reportApi.js';
import { Button } from '../../components/Button.js';
import { Muted } from '../../components/Muted.js';

const fmt = (row: Record<string, unknown>, skip: string): string =>
  Object.entries(row)
    .filter(([k]) => k !== skip)
    .map(([k, v]) => `${k} ${typeof v === 'number' && v > 0 ? '+' : ''}${String(v)}`)
    .join(' · ');

/** 저장한 스냅샷 둘(전, 후)을 골라 증감을 보인다. */
export const CompareReports = () => {
  const [open, setOpen] = useState(false);
  const names = open ? snapshotNames() : [];
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const a = getSnapshot(before);
  const b = getSnapshot(after);
  const result = a && b ? compare(a, b) : null;
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
                  {r.endpoint} {r.status ?? ''} {fmt(r, 'endpoint')}
                </div>
              ))}
              {result.renders.map((r) => (
                <div key={r.name}>
                  &lt;{r.name}&gt; {r.status ?? ''} {fmt(r, 'name')}
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
