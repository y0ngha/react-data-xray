import { buildDiagnostics, type RdxDiagnostics } from '../../core/diagnostics/diagnostics.js';
import { STATUS_LABELS as L } from '../../core/diagnostics/messages.js';
import { useNow } from '../hooks/useNow.js';
import { color } from '../theme.js';

const REFRESH_MS = 2000;

const renderHookText = ({ renderHook: h }: RdxDiagnostics): string => {
  if (!h.listening) return L.notListening;
  const parts = [h.commitsSeen > 0 ? `${h.commitsSeen} ${L.commits}` : L.noCommits, `React ${h.reactVersion}`];
  if (h.strictMode) parts.push(L.strictMode);
  else if (h.strictMode === null) parts.push(`${L.strictMode} ?`);
  return parts.join(', ');
};

const captureText = ({ capture: c, requests: r }: RdxDiagnostics): string => {
  if (!c.installed) return L.captureOff;
  const kinds = [c.fetch && 'fetch', c.xhr && 'XHR'].filter(Boolean).join('+') || L.captureOff;
  const before = c.requestsBeforeInstall ? `, ${c.requestsBeforeInstall} ${L.beforeLoad}` : '';
  return `${kinds}, ${r.recorded} ${L.requests}, ${r.jsonResponses} ${L.jsonResponses}${before}`;
};

const Item = ({ label, children }: { label: string; children: string | number }) => (
  <span style={{ whiteSpace: 'nowrap' }}>
    <span style={{ color: color.muted }}>{label}:</span> {children}
  </span>
);

/** 도구 막대의 상태 줄: window.__RDX__.doctor() 와 같은 값. 펼쳐 둔 동안만 2초마다 다시 읽는다. */
export const StatusLine = () => {
  useNow(REFRESH_MS); // 2초마다 다시 그려 새 값을 읽는다
  // 카운터와 상태를 읽을 뿐 큐를 비우지 않는다.
  const d = buildDiagnostics();
  return (
    <output style={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Item label={L.renderHook}>{renderHookText(d)}</Item>
        <Item label={L.capture}>{captureText(d)}</Item>
        <Item label={L.reportPlugin}>{d.reportPlugin}</Item>
        <Item label={L.sourceMaps}>{d.sourceMaps.failures}</Item>
        <Item label={L.sameResponse}>{`${d.sameResponseMemory.keys} ${L.keys}`}</Item>
      </div>
      {d.problems.length === 0 ? (
        <div style={{ color: color.exact }}>{L.ok}</div>
      ) : (
        d.problems.map((p) => (
          <div key={p} style={{ color: color.warn }}>
            ⚠ {p}
          </div>
        ))
      )}
    </output>
  );
};
