import { useEffect, useRef, useState } from 'react';

import { keepSnapshot, NO_PLUGIN_MESSAGE, snapshotNames } from '../../../core/report/reportApi.js';
import { isReportName } from '../../../shared/reportPath.js';
import { Button } from '../../components/Button.js';
import { color } from '../../theme.js';

/** 저장에 성공하면 보낸다. 옆의 CompareReports 가 이름 목록을 다시 읽는다. */
export const SNAPSHOT_SAVED_EVENT = 'rdx:snapshot-saved';

const defaultName = (): string => {
  const names = new Set(snapshotNames());
  if (names.size === 0) return 'before';
  let n = 1;
  while (names.has(n === 1 ? 'after' : `after-${n}`)) n++;
  return n === 1 ? 'after' : `after-${n}`;
};

type Phase = { kind: 'idle' } | { kind: 'open'; name: string; error: string } | { kind: 'done'; status: string };

/** 도구 막대의 스냅샷 저장. 이름을 받아 window.__RDX__.snapshot(name) 을 부른다(콘솔과 같은 동작). */
export const SnapshotButton = () => {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  // 입력란이 열리면 바로 이름을 고칠 수 있게 한다.
  useEffect(() => {
    if (phase.kind === 'open') inputRef.current?.focus();
  }, [phase.kind]);

  const open = () => setPhase({ kind: 'open', name: defaultName(), error: '' });

  const save = async (name: string) => {
    if (!isReportName(name)) {
      setPhase({ kind: 'open', name, error: 'Letters, digits, . _ - only; up to 64 chars; not "report"' });
      return;
    }
    try {
      await window.__RDX__!.snapshot(name);
      window.dispatchEvent(new Event(SNAPSHOT_SAVED_EVENT));
      setPhase({ kind: 'done', status: `Saved to .rdx/${name}.json` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === NO_PLUGIN_MESSAGE) {
        // 플러그인이 없으면 파일은 못 쓰지만 이 탭에 남겨 비교에는 쓸 수 있게 한다.
        const rpt = window.__RDX__!.report();
        keepSnapshot(name, rpt);
        window.dispatchEvent(new Event(SNAPSHOT_SAVED_EVENT));
        setPhase({ kind: 'done', status: 'Tab only — no dev-server plugin' });
      } else {
        setPhase({ kind: 'open', name, error: msg.replace('[react-data-xray] ', '').slice(0, 80) });
      }
    }
  };

  if (phase.kind === 'idle') {
    return (
      <Button onClick={open} title="Save a named snapshot to compare before/after">
        Save
      </Button>
    );
  }

  if (phase.kind === 'done') {
    return (
      <>
        <Button onClick={open} title="Save another snapshot">
          Save
        </Button>
        <span style={{ color: color.muted, marginLeft: 4 }}>{phase.status}</span>
      </>
    );
  }

  // open
  return (
    <>
      <input
        ref={inputRef}
        aria-label="Snapshot name"
        value={phase.name}
        onChange={(e) => setPhase({ kind: 'open', name: e.target.value, error: '' })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save(phase.name);
          if (e.key === 'Escape') setPhase({ kind: 'idle' });
        }}
        style={{
          width: 80,
          font: 'inherit',
          background: color.panel,
          color: color.text,
          border: `1px solid ${color.border}`,
          borderRadius: 4,
          padding: '2px 4px',
        }}
      />
      <Button onClick={() => void save(phase.name)} title="Save snapshot">
        Save
      </Button>
      <Button onClick={() => setPhase({ kind: 'idle' })} title="Cancel">
        ✕
      </Button>
      {phase.error && <span style={{ color: color.warn }}>{phase.error}</span>}
    </>
  );
};
