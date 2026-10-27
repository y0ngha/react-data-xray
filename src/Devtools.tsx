import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { collectBoxes, inspect, inspectFiber, type Box, type Hit, type InspectResult } from './inspect.js';
import { endpointOf, getRecords, pathOf as shortUrl, subscribe, type RequestRecord } from './registry.js';
import { getCommits, getTopRenders, ignoreComponent, setRenderMonitoring } from './renderMonitor.js';

export interface DataSourceDevtoolsProps {
  /** 요소 선택 단축키. 기본값 Ctrl+Shift+D (macOS 는 Cmd 도 허용) */
  hotkey?: { key: string; shift?: boolean; alt?: boolean };
}

type Tab = 'inspect' | 'requests' | 'timeline' | 'renders';

const ROOT_ATTR = 'data-dsi-root';
const Z = 2147483647;
const POSITION_KEY = 'data-source-inspector:button';

const isOwnUi = (el: Element | null) => !!el?.closest(`[${ROOT_ATTR}]`);

const color = {
  bg: '#111',
  panel: '#1a1a1a',
  border: '#333',
  text: '#eee',
  muted: '#9ca3af',
  accent: '#3b82f6',
  exact: '#4ade80',
  derived: '#60a5fa',
  text_: '#facc15',
  warn: '#f87171',
};

const MATCH_LABEL = { exact: '정확', derived: '파생', text: '추정' } as const;
const MATCH_COLOR = { exact: color.exact, derived: color.derived, text: color.text_ } as const;

const formatJson = (value: unknown): string => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return String(value);
  }
};

const queryOf = (url: string): string => {
  try {
    return new URL(url, location.href).search;
  } catch {
    return '';
  }
};

const truncate = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 같은 엔드포인트라도 쿼리·payload 가 다를 수 있어 함께 보여 준다. */
const RequestParams = ({ record }: { record: RequestRecord }) => {
  const query = queryOf(record.url);
  return (
    <>
      {query && <div style={{ color: color.muted }}>query: {truncate(decodeURIComponent(query))}</div>}
      {record.requestBody && <div style={{ color: color.muted }}>payload: {truncate(record.requestBody)}</div>}
      {record.bodyUnreadable && <div style={{ color: color.muted }}>payload: (읽을 수 없는 본문, 중복 판정 제외)</div>}
    </>
  );
};

const valueAt = (body: unknown, path: string): unknown => {
  const keys = path.replace(/^\$/, '').match(/[^.[\]]+/g) ?? [];
  return keys.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], body);
};


// ---- 요청 감시 지표 ----

interface EndpointStat {
  endpoint: string;
  count: number;
  duplicates: number;
  sameResponses: number;
  avgMs: number;
}

const getEndpointStats = (records: readonly RequestRecord[]): EndpointStat[] => {
  const map = new Map<string, EndpointStat & { totalMs: number }>();
  for (const r of records) {
    const endpoint = endpointOf(r);
    const s = map.get(endpoint) ?? { endpoint, count: 0, duplicates: 0, sameResponses: 0, avgMs: 0, totalMs: 0 };
    s.count++;
    s.totalMs += r.durationMs;
    if (r.duplicateOf) s.duplicates++;
    if (r.sameResponseAs) s.sameResponses++;
    map.set(endpoint, s);
  }
  return Array.from(map.values())
    .map((s) => ({ ...s, avgMs: Math.round(s.totalMs / s.count) }))
    .sort((a, b) => b.duplicates + b.sameResponses - (a.duplicates + a.sameResponses) || b.count - a.count);
};

const isWasteful = (stat: EndpointStat | undefined) => !!stat && (stat.duplicates > 0 || stat.sameResponses > 0);

const useRecords = () => {
  // 요청이 몰리면 패널이 매번 다시 그려지지 않도록 버전 숫자만 구독한다.
  const version = useRef(0);
  return useSyncExternalStore(
    (cb) =>
      subscribe(() => {
        version.current++;
        cb();
      }),
    () => version.current,
  );
};

// ---- 작은 UI 조각 ----

const Badge = ({ c, children }: { c: string; children: ReactNode }) => (
  <span style={{ color: c, border: `1px solid ${c}`, borderRadius: 4, padding: '0 4px', marginRight: 4, fontSize: 11 }}>{children}</span>
);

const Button = ({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: ReactNode; title?: string }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    style={{
      background: active ? color.accent : 'transparent',
      color: color.text,
      border: `1px solid ${active ? color.accent : color.border}`,
      borderRadius: 4,
      padding: '2px 8px',
      cursor: 'pointer',
      font: 'inherit',
    }}
  >
    {children}
  </button>
);

const RequestFlags = ({ record, stat }: { record: RequestRecord; stat?: EndpointStat }) => (
  <>
    {record.duplicateOf && <Badge c={color.warn}>중복 요청</Badge>}
    {record.sameResponseAs && <Badge c={color.warn}>같은 응답 재요청</Badge>}
    {stat && stat.count > 1 && <Badge c={isWasteful(stat) ? color.warn : color.muted}>최근 {stat.count}회 호출</Badge>}
  </>
);

const HitRow = ({ hit, stats }: { hit: Hit; stats: Map<string, EndpointStat> }) => (
  <div style={{ padding: '6px 0', borderTop: `1px solid ${color.border}` }}>
    <div>
      <Badge c={MATCH_COLOR[hit.match]}>{MATCH_LABEL[hit.match]}</Badge>
      {hit.record.method} {shortUrl(hit.record.url)}
    </div>
    <div style={{ color: color.muted }}>
      {hit.record.kind} · {hit.record.status} · {hit.record.durationMs}ms · {new Date(hit.record.startedAt).toLocaleTimeString()}
    </div>
    <RequestParams record={hit.record} />
    <div>
      <RequestFlags record={hit.record} stat={stats.get(endpointOf(hit.record))} />
    </div>
    <div>
      경로: <code>{hit.path}</code> ← <code>{hit.via}</code>
    </div>
    {hit.queryKey !== undefined && (
      <div>
        queryKey: <code>{formatJson(hit.queryKey)}</code>
      </div>
    )}
    <div style={{ color: color.muted }}>값: {formatJson(valueAt(hit.record.body, hit.path))}</div>
  </div>
);

// ---- 탭 ----

const InspectTab = ({ result, stats }: { result: InspectResult | null; stats: Map<string, EndpointStat> }) => {
  if (!result) return <div style={{ color: color.muted }}>[요소 선택]을 누르고 화면의 요소를 클릭하세요.</div>;
  const withHits = result.components.filter((c) => c.hits.length > 0);
  return (
    <div>
      <div style={{ color: color.muted }}>
        {result.components
          .slice(0, 4)
          .map((c) => c.name)
          .join(' ← ')}
      </div>
      {withHits.map((c, i) => (
        <div key={i} style={{ marginTop: 8 }}>
          <div style={{ color: '#93c5fd' }}>&lt;{c.name}&gt;</div>
          {c.hits.map((h, j) => (
            <HitRow key={j} hit={h} stats={stats} />
          ))}
        </div>
      ))}
      {withHits.length === 0 && result.guesses.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: color.muted }}>컴포넌트 데이터로는 못 찾아 화면 글자로 찾은 결과입니다.</div>
          {result.guesses.map((h, i) => (
            <HitRow key={i} hit={h} stats={stats} />
          ))}
        </div>
      )}
      {withHits.length === 0 && result.guesses.length === 0 && <div style={{ color: color.muted, marginTop: 8 }}>연결된 API 응답을 찾지 못했습니다.</div>}
    </div>
  );
};

const RequestsTab = ({ records, stats }: { records: readonly RequestRecord[]; stats: EndpointStat[] }) => {
  const [view, setView] = useState<'endpoints' | 'log'>('endpoints');
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <Button active={view === 'endpoints'} onClick={() => setView('endpoints')}>
          엔드포인트별
        </Button>
        <Button active={view === 'log'} onClick={() => setView('log')}>
          전체 기록
        </Button>
        <span style={{ color: color.muted, marginLeft: 'auto' }}>최근 {records.length}건</span>
      </div>
      {view === 'endpoints'
        ? stats.map((s) => (
            <div key={s.endpoint} style={{ padding: '4px 0', borderTop: `1px solid ${color.border}` }}>
              <div style={{ color: isWasteful(s) ? color.warn : color.text }}>{s.endpoint}</div>
              <div style={{ color: color.muted }}>
                {s.count}회 · 평균 {s.avgMs}ms
                {s.duplicates > 0 && <span style={{ color: color.warn }}> · 중복 {s.duplicates}</span>}
                {s.sameResponses > 0 && <span style={{ color: color.warn }}> · 같은 응답 {s.sameResponses}</span>}
              </div>
            </div>
          ))
        : [...records].reverse().map((r) => (
            <div key={r.id} style={{ padding: '4px 0', borderTop: `1px solid ${color.border}` }}>
              <div>
                {r.method} {shortUrl(r.url)}
              </div>
              <div style={{ color: color.muted }}>
                {r.kind} · {r.status} · {r.durationMs}ms · {new Date(r.startedAt).toLocaleTimeString()}{' '}
                {r.duplicateOf && <Badge c={color.warn}>중복</Badge>}
                {r.sameResponseAs && <Badge c={color.warn}>같은 응답</Badge>}
              </div>
              <RequestParams record={r} />
            </div>
          ))}
    </div>
  );
};

const RendersTab = ({ statsByEndpoint }: { statsByEndpoint: Map<string, EndpointStat> }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    setRenderMonitoring(true);
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      window.clearInterval(timer);
      setRenderMonitoring(false);
    };
  }, []);
  // 같은 컴포넌트가 여러 개 렌더되면(목록의 행 등) 이름별로 묶는다.
  const grouped = new Map<string, { name: string; recent: number; instances: number; fiber: unknown }>();
  for (const e of getTopRenders(200)) {
    const g = grouped.get(e.name);
    if (g) {
      g.recent += e.recent;
      g.instances++;
    } else grouped.set(e.name, { name: e.name, recent: e.recent, instances: 1, fiber: e.fiber });
  }
  const top = Array.from(grouped.values())
    .sort((a, b) => b.recent - a.recent)
    .slice(0, 20);
  return (
    <div>
      <div style={{ color: color.muted, marginBottom: 8 }}>이 탭을 연 동안 최근 10초 렌더 횟수입니다.</div>
      {top.length === 0 && <div style={{ color: color.muted }}>아직 렌더가 없습니다. 화면을 조작해 보세요.</div>}
      {top.map((e, i) => {
        // 렌더가 잦은 컴포넌트가 어떤 요청의 데이터를 쓰는지 같이 보여 준다.
        const hit = inspectFiber(e.fiber as never)[0];
        const stat = hit ? statsByEndpoint.get(endpointOf(hit.record)) : undefined;
        return (
          <div key={i} style={{ padding: '4px 0', borderTop: `1px solid ${color.border}` }}>
            <div>
              <b style={{ color: e.recent / e.instances >= 10 ? color.warn : color.text }}>{e.recent}회</b> &lt;{e.name}&gt;
              {e.instances > 1 && <span style={{ color: color.muted }}> × {e.instances}개</span>}
            </div>
            {hit && (
              <div style={{ color: color.muted }}>
                ← {hit.record.method} {shortUrl(hit.record.url)}{' '}
                {stat && stat.duplicates > 0 && <Badge c={color.warn}>중복 {stat.duplicates}</Badge>}
                {stat && stat.sameResponses > 0 && <Badge c={color.warn}>같은 응답 {stat.sameResponses}</Badge>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---- 타임라인: 요청 막대 + 렌더 commit 눈금 + 요청 몰림 구간 ----

const TIMELINE_MS = 20_000;
const BURST_WINDOW_MS = 500;
const BURST_MIN = 5;
const LANE_H = 6;
const MAX_LANES = 14;
const COMMIT_H = 40;

/** 500ms 안에 요청이 5건 이상 몰린 구간. 겹치는 구간은 합친다. */
export const findBursts = (starts: number[]): Array<{ from: number; to: number; count: number }> => {
  const sorted = [...starts].sort((a, b) => a - b);
  const bursts: Array<{ from: number; to: number; count: number }> = [];
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[i] - sorted[j] > BURST_WINDOW_MS) j++;
    if (i - j + 1 < BURST_MIN) continue;
    const last = bursts[bursts.length - 1];
    if (last && sorted[j] <= last.to) {
      last.to = sorted[i];
      last.count = sorted.filter((t) => t >= last.from && t <= last.to).length;
    } else bursts.push({ from: sorted[j], to: sorted[i], count: i - j + 1 });
  }
  return bursts;
};

const TimelineTab = ({ records }: { records: readonly RequestRecord[] }) => {
  const [now, setNow] = useState(Date.now());
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    setRenderMonitoring(true);
    return () => setRenderMonitoring(false);
  }, []);
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [paused]);

  const width = 456;
  const from = now - TIMELINE_MS;
  const x = (t: number) => ((t - from) / TIMELINE_MS) * width;
  const visible = records.filter((r) => r.startedAt + r.durationMs >= from);
  // 겹치는 요청은 아래 줄로 쌓는다.
  const laneEnds: number[] = [];
  const bars = visible.map((r) => {
    let lane = laneEnds.findIndex((end) => end <= r.startedAt);
    if (lane === -1) lane = laneEnds.length < MAX_LANES ? laneEnds.length : MAX_LANES - 1;
    laneEnds[lane] = r.startedAt + Math.max(r.durationMs, 1);
    return { r, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  const reqH = lanes * (LANE_H + 2);
  const commits = getCommits().filter((c) => c.time >= from);
  const maxCount = Math.max(1, ...commits.map((c) => c.count));
  const bursts = findBursts(visible.map((r) => r.startedAt));
  const height = reqH + COMMIT_H + 20;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: color.muted }}>
        <span>최근 20초</span>
        <span>
          <span style={{ color: color.accent }}>■</span> 요청 <span style={{ color: color.warn }}>■</span> 중복·같은 응답{' '}
          <span style={{ color: '#a78bfa' }}>▮</span> 렌더(높이 = 렌더된 컴포넌트 수)
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button active={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ 재개' : '❚❚ 멈춤'}
          </Button>
        </span>
      </div>
      <svg width={width} height={height} style={{ display: 'block', background: color.panel, borderRadius: 4 }}>
        {bursts.map((b, i) => (
          <g key={`b${i}`}>
            <rect x={x(b.from) - 2} y={0} width={Math.max(4, x(b.to) - x(b.from) + 4)} height={height - 14} fill={color.warn} opacity={0.18} />
            <text x={x(b.from)} y={height - 16} fill={color.warn} fontSize={10}>
              요청 몰림 {b.count}건
            </text>
          </g>
        ))}
        {bars.map(({ r, lane }) => {
          const wasteful = !!(r.duplicateOf || r.sameResponseAs);
          return (
            <rect key={r.id} x={x(r.startedAt)} y={lane * (LANE_H + 2) + 2} width={Math.max(2, x(r.startedAt + r.durationMs) - x(r.startedAt))} height={LANE_H} fill={wasteful ? color.warn : color.accent}>
              <title>{`${r.method} ${shortUrl(r.url)}${queryOf(r.url)}\n${r.status} · ${r.durationMs}ms${r.duplicateOf ? ' · 중복 요청' : ''}${r.sameResponseAs ? ' · 같은 응답 재요청' : ''}`}</title>
            </rect>
          );
        })}
        <line x1={0} x2={width} y1={reqH + 4} y2={reqH + 4} stroke={color.border} />
        {commits.map((c, i) => {
          const h = Math.max(2, (c.count / maxCount) * COMMIT_H);
          return (
            <rect key={`c${i}`} x={x(c.time)} y={reqH + 6 + COMMIT_H - h} width={2} height={h} fill="#a78bfa">
              <title>{`${new Date(c.time).toLocaleTimeString()} · 컴포넌트 ${c.count}개 렌더`}</title>
            </rect>
          );
        })}
        {[0, 5, 10, 15, 20].map((sec) => (
          <text key={sec} x={Math.min(width - 24, x(now - sec * 1000))} y={height - 2} fill={color.muted} fontSize={9}>
            -{sec}s
          </text>
        ))}
      </svg>
      <div style={{ color: color.muted, marginTop: 6 }}>
        막대에 마우스를 올리면 요청 정보가 보입니다. 요청이 몰린 직후 렌더 눈금이 연달아 찍히면 요청마다 따로 렌더되고 있다는 뜻입니다.
      </div>
    </div>
  );
};

// ---- 전체 표시 오버레이 ----

const Overlay = ({ statsByEndpoint }: { statsByEndpoint: Map<string, EndpointStat> }) => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    const refresh = () => setBoxes(collectBoxes((el) => isOwnUi(el)));
    refresh();
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, []);
  return (
    <>
      {boxes.map((b, i) => {
        const wasteful = isWasteful(statsByEndpoint.get(endpointOf(b.hit.record)));
        const c = wasteful ? color.warn : MATCH_COLOR[b.hit.match];
        return (
          <div
            key={i}
            style={{
              position: 'fixed',
              left: b.rect.left,
              top: b.rect.top,
              width: b.rect.width,
              height: b.rect.height,
              outline: `1px solid ${c}`,
              background: `${c}14`,
              pointerEvents: 'none',
              zIndex: Z - 2,
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                background: c,
                color: '#000',
                font: '10px/1.4 ui-monospace, Menlo, monospace',
                padding: '0 3px',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                overflow: 'hidden',
              }}
            >
              {shortUrl(b.hit.record.url)}
            </span>
          </div>
        );
      })}
    </>
  );
};

// ---- 드래그 가능한 플로팅 버튼 ----

const readPosition = (): { x: number; y: number } => {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? '');
    if (typeof saved?.x === 'number' && typeof saved?.y === 'number') return saved;
  } catch {
    // 저장된 위치가 없거나 저장소를 못 쓰면 기본 위치를 쓴다.
  }
  return { x: window.innerWidth - 64, y: window.innerHeight - 64 };
};

const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);

const useDraggable = () => {
  const [pos, setPos] = useState(readPosition);
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const x = clamp(e.clientX - drag.current.dx, window.innerWidth - 44);
    const y = clamp(e.clientY - drag.current.dy, window.innerHeight - 44);
    if (Math.abs(x - pos.x) + Math.abs(y - pos.y) > 3) drag.current.moved = true;
    if (drag.current.moved) setPos({ x, y });
  };
  /** 드래그였으면 true 를 돌려줘 클릭으로 처리하지 않게 한다. */
  const onPointerUp = (): boolean => {
    const moved = !!drag.current?.moved;
    drag.current = null;
    if (moved) {
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
      } catch {
        // 위치 저장은 편의 기능이라 실패해도 넘어간다.
      }
    }
    return moved;
  };
  return { pos, onPointerDown, onPointerMove, onPointerUp };
};

// ---- 본체 ----

const panelStyle: CSSProperties = {
  position: 'fixed',
  width: 480,
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  zIndex: Z,
  background: color.bg,
  color: color.text,
  font: '12px/1.5 ui-monospace, Menlo, monospace',
  borderRadius: 8,
  boxShadow: '0 4px 24px rgba(0,0,0,.4)',
  wordBreak: 'break-all',
};

export const DataSourceDevtools = ({ hotkey = { key: 'd', shift: true } }: DataSourceDevtoolsProps) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('inspect');
  const [picking, setPicking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [result, setResult] = useState<InspectResult | null>(null);
  const { pos, onPointerDown, onPointerMove, onPointerUp } = useDraggable();
  useRecords();

  const records = getRecords();
  const stats = getEndpointStats(records);
  const statsByEndpoint = new Map(stats.map((s) => [s.endpoint, s]));
  const wastefulCount = stats.filter(isWasteful).length;

  const startPicking = () => {
    setOpen(true);
    setTab('inspect');
    setPicking(true);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicking(false);
        return;
      }
      const matches =
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === hotkey.key.toLowerCase() &&
        !!hotkey.shift === e.shiftKey &&
        !!hotkey.alt === e.altKey;
      if (matches) {
        e.preventDefault();
        setOpen(true);
        setTab('inspect');
        setPicking((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkey.key, hotkey.shift, hotkey.alt]);

  useEffect(() => {
    if (!picking) {
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
      setPicking(false);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [picking]);

  // 패널은 버튼 위쪽(공간이 없으면 아래쪽)에, 화면 밖으로 나가지 않게 둔다.
  const panelLeft = clamp(pos.x + 44 - 480, window.innerWidth - 480);
  const panelPos: CSSProperties = pos.y > window.innerHeight / 2 ? { left: panelLeft, bottom: window.innerHeight - pos.y + 8 } : { left: panelLeft, top: pos.y + 52 };

  return createPortal(
    <div {...{ [ROOT_ATTR]: '' }}>
      {showAll && <Overlay statsByEndpoint={statsByEndpoint} />}
      {hoverRect && (
        <div
          style={{
            position: 'fixed',
            left: hoverRect.left,
            top: hoverRect.top,
            width: hoverRect.width,
            height: hoverRect.height,
            outline: `2px solid ${color.accent}`,
            background: 'rgba(59,130,246,.15)',
            pointerEvents: 'none',
            zIndex: Z - 1,
          }}
        />
      )}
      {open && (
        <div style={{ ...panelStyle, ...panelPos }} role="dialog" aria-label="Data source inspector">
          <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: `1px solid ${color.border}`, flexWrap: 'wrap' }}>
            <Button active={picking} onClick={() => (picking ? setPicking(false) : startPicking())} title={`요소 선택 (Ctrl/Cmd+Shift+${hotkey.key.toUpperCase()})`}>
              ⌖ 요소 선택
            </Button>
            <Button active={showAll} onClick={() => setShowAll((v) => !v)} title="데이터 출처가 있는 요소를 모두 표시">
              ▦ 전체 표시
            </Button>
            <span style={{ flex: 1 }} />
            <Button active={tab === 'inspect'} onClick={() => setTab('inspect')}>
              검사
            </Button>
            <Button active={tab === 'requests'} onClick={() => setTab('requests')}>
              요청{wastefulCount > 0 ? ` ⚠${wastefulCount}` : ''}
            </Button>
            <Button active={tab === 'timeline'} onClick={() => setTab('timeline')}>
              타임라인
            </Button>
            <Button active={tab === 'renders'} onClick={() => setTab('renders')}>
              렌더
            </Button>
            <Button onClick={() => setOpen(false)} title="닫기">
              ✕
            </Button>
          </div>
          <div style={{ padding: 8, overflow: 'auto' }}>
            {picking && <div style={{ color: color.accent, marginBottom: 8 }}>화면의 요소를 클릭하세요. (Esc 취소)</div>}
            {tab === 'inspect' && <InspectTab result={result} stats={statsByEndpoint} />}
            {tab === 'requests' && <RequestsTab records={records} stats={stats} />}
            {tab === 'timeline' && <TimelineTab records={records} />}
            {tab === 'renders' && <RendersTab statsByEndpoint={statsByEndpoint} />}
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label="Data source inspector 열기"
        title="Data source inspector (드래그로 이동)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          if (!onPointerUp()) setOpen((v) => !v);
        }}
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width: 44,
          height: 44,
          borderRadius: '50%',
          border: `2px solid ${wastefulCount > 0 ? color.warn : color.accent}`,
          background: color.bg,
          color: color.text,
          font: 'bold 14px ui-monospace, Menlo, monospace',
          cursor: 'grab',
          zIndex: Z,
          boxShadow: '0 2px 12px rgba(0,0,0,.4)',
          touchAction: 'none',
        }}
      >
        API
      </button>
    </div>,
    document.body,
  );
};

// 패널 자신의 렌더는 렌더 감시에서 뺀다.
ignoreComponent(DataSourceDevtools);
