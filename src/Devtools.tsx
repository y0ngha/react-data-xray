import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { inspect, type Hit, type InspectResult } from './inspect';

export interface DataSourceDevtoolsProps {
  /** 검사 모드 토글 단축키. 기본값 Ctrl+Shift+D (macOS 는 Cmd 도 허용) */
  hotkey?: { key: string; shift?: boolean; alt?: boolean };
}

const ROOT_ATTR = 'data-dsi-root';
const Z = 2147483647;

const isOwnUi = (el: Element | null) => !!el?.closest(`[${ROOT_ATTR}]`);

const formatJson = (value: unknown): string => {
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return String(value);
  }
};

const valueAt = (body: unknown, path: string): unknown => {
  const keys = path.replace(/^\$/, '').match(/[^.[\]]+/g) ?? [];
  return keys.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], body);
};

const HitRow = ({ hit }: { hit: Hit }) => (
  <div style={{ padding: '6px 0', borderTop: '1px solid #333' }}>
    <div>
      <b style={{ color: hit.exact ? '#4ade80' : '#facc15' }}>[{hit.exact ? '정확' : '추정'}]</b>{' '}
      {hit.record.method} {hit.record.url}
    </div>
    <div style={{ color: '#aaa' }}>
      {hit.record.status} · {hit.record.durationMs}ms · {new Date(hit.record.startedAt).toLocaleTimeString()}
    </div>
    <div>
      경로: <code>{hit.path}</code> ← <code>{hit.via}</code>
    </div>
    {hit.queryKey !== undefined && (
      <div>
        queryKey: <code>{formatJson(hit.queryKey)}</code>
      </div>
    )}
    <div style={{ color: '#aaa' }}>값: {formatJson(valueAt(hit.record.body, hit.path))}</div>
  </div>
);

const panelStyle: CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 12,
  width: 460,
  maxHeight: '60vh',
  overflow: 'auto',
  zIndex: Z,
  background: '#111',
  color: '#eee',
  font: '12px/1.5 ui-monospace, Menlo, monospace',
  padding: 12,
  borderRadius: 8,
  boxShadow: '0 4px 24px rgba(0,0,0,.4)',
  wordBreak: 'break-all',
};

export const DataSourceDevtools = ({ hotkey = { key: 'd', shift: true } }: DataSourceDevtoolsProps) => {
  const [active, setActive] = useState(false);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [result, setResult] = useState<InspectResult | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActive(false);
        setResult(null);
        return;
      }
      const matches =
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === hotkey.key.toLowerCase() &&
        !!hotkey.shift === e.shiftKey &&
        !!hotkey.alt === e.altKey;
      if (matches) {
        e.preventDefault();
        setActive((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkey.key, hotkey.shift, hotkey.alt]);

  useEffect(() => {
    if (!active) {
      setHoverRect(null);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      setHoverRect(el && !isOwnUi(el) ? el.getBoundingClientRect() : null);
    };
    // 캡처 단계에서 막아 앱의 클릭 핸들러가 실행되지 않게 한다.
    const onClick = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || isOwnUi(el)) return;
      e.preventDefault();
      e.stopPropagation();
      setResult(inspect(el));
      setActive(false);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [active]);

  const withHits = result?.components.filter((c) => c.hits.length > 0) ?? [];

  return createPortal(
    <div {...{ [ROOT_ATTR]: '' }}>
      {hoverRect && (
        <div
          style={{
            position: 'fixed',
            left: hoverRect.left,
            top: hoverRect.top,
            width: hoverRect.width,
            height: hoverRect.height,
            outline: '2px solid #3b82f6',
            background: 'rgba(59,130,246,.15)',
            pointerEvents: 'none',
            zIndex: Z,
          }}
        />
      )}
      {active && !result && <div style={{ ...panelStyle, width: 'auto' }}>검사 모드: 요소를 클릭하세요 (Esc 취소)</div>}
      {result && (
        <div style={panelStyle} role="dialog" aria-label="Data source">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <b>
              {result.components
                .map((c) => c.name)
                .slice(0, 4)
                .join(' ← ')}
            </b>
            <button type="button" onClick={() => setResult(null)} style={{ color: '#eee', background: 'none', border: 0, cursor: 'pointer' }}>
              ✕
            </button>
          </div>
          {withHits.map((c) => (
            <div key={c.name} style={{ marginTop: 8 }}>
              <div style={{ color: '#93c5fd' }}>&lt;{c.name}&gt;</div>
              {c.hits.map((h, i) => (
                <HitRow key={i} hit={h} />
              ))}
            </div>
          ))}
          {withHits.length === 0 && result.guesses.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: '#aaa' }}>참조로는 못 찾아 화면 글자로 찾은 결과입니다.</div>
              {result.guesses.map((h, i) => (
                <HitRow key={i} hit={h} />
              ))}
            </div>
          )}
          {withHits.length === 0 && result.guesses.length === 0 && <div style={{ color: '#aaa' }}>연결된 API 응답을 찾지 못했습니다.</div>}
        </div>
      )}
    </div>,
    document.body,
  );
};
