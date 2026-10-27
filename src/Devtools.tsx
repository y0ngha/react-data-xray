import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { collectBoxes, findConsumers, inspect, inspectFiber, type Box, type Consumer, type Hit, type InspectResult } from './inspect.js';
import { endpointOf, getRecords, pathOf as shortUrl, subscribe, type RequestRecord } from './registry.js';
import { CLASS_LABEL, classifyRecords, isInitialLoad, isWaste, needsReview, type RequestClass } from './classify.js';
import { getCommits, getRenderInfo, getTopRenders, setRenderMonitoring, subscribeCommits, type RenderReason, type RenderSummary } from './renderMonitor.js';

export interface RdxDevtoolsProps {
  /** 요소 선택 단축키. 기본값 Ctrl+Shift+D (macOS 는 Cmd 도 허용) */
  hotkey?: { key: string; shift?: boolean; alt?: boolean };
}

type Tab = 'inspect' | 'requests' | 'timeline' | 'renders';

const ROOT_ATTR = 'data-rdx-root';
const Z = 2147483647;
const POSITION_KEY = 'react-data-xray:button';
const DOCK_KEY = 'react-data-xray:dock';
const IGNORE_KEY = 'react-data-xray:ignored-endpoints';

/** float: 버튼 옆 작은 패널 · bottom/right: 화면 가장자리에 도킹 · window: 별도 창(도킹 해제) */
type Dock = 'float' | 'bottom' | 'right' | 'window';

interface DockSettings {
  dock: Dock;
  bottomHeight: number;
  rightWidth: number;
}

const DEFAULT_DOCK: DockSettings = { dock: 'float', bottomHeight: 320, rightWidth: 520 };

const readDock = (): DockSettings => {
  try {
    const saved = JSON.parse(localStorage.getItem(DOCK_KEY) ?? '');
    if (saved && ['float', 'bottom', 'right', 'window'].includes(saved.dock)) return { ...DEFAULT_DOCK, ...saved };
  } catch {
    // 저장된 설정이 없거나 저장소를 못 쓰면 기본값을 쓴다.
  }
  return DEFAULT_DOCK;
};

const saveDock = (settings: DockSettings) => {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(settings));
  } catch {
    // 설정 저장은 편의 기능이라 실패해도 넘어간다.
  }
};

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
  review: '#fbbf24',
};

/** 낭비는 빨강, 확인 필요는 노랑, 정상은 회색 */
const classColor = (c: RequestClass) => (isWaste(c) ? color.warn : needsReview(c) ? color.review : color.muted);

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


// ---- 요청 분류: 낭비(빨강)와 이유 있는 반복(회색)을 화면 전체에서 같은 기준으로 쓴다 ----

const ClassContext = createContext<(record: RequestRecord) => RequestClass>(() => 'ok');

/** 요청 분류 배지. 낭비는 빨강, 주기 요청·StrictMode·무시는 회색으로 보여 준다. */
const ClassBadge = ({ record, short }: { record: RequestRecord; short?: boolean }) => {
  const c = useContext(ClassContext)(record);
  if (c === 'ok') return null;
  const label = short ? CLASS_LABEL[c].replace(' 재요청', '').replace(' 요청', '') : CLASS_LABEL[c];
  return <Badge c={classColor(c)}>{label}</Badge>;
};

const readIgnored = (): Set<string> => {
  try {
    const saved = JSON.parse(localStorage.getItem(IGNORE_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
};

// ---- 요청 상세: rdx 가 보여 주는 모든 요청에서 클릭하면 연다 ----

/** 검사 결과에서 연 경우, 컴포넌트가 실제로 쓰는 응답 위치 */
interface Focus {
  path: string;
  via: string;
}

const OpenRequestContext = createContext<(record: RequestRecord, focus?: Focus) => void>(() => undefined);

/** 호버한 요청. 그 응답 데이터를 쓰는 컴포넌트를 화면에서 강조한다. */
const HoverRequestContext = createContext<(record: RequestRecord | null) => void>(() => undefined);

/** 감싼 내용을 클릭하면 그 요청의 상세 화면을 열고, 호버하면 이 요청의 데이터를 쓰는 컴포넌트를 강조한다. */
const RequestLink = ({ record, focus, children }: { record: RequestRecord; focus?: Focus; children: ReactNode }) => {
  const openRequest = useContext(OpenRequestContext);
  const hoverRequest = useContext(HoverRequestContext);
  return (
    <div
      onMouseEnter={() => hoverRequest(record)}
      onMouseLeave={() => hoverRequest(null)}
      role="button"
      tabIndex={0}
      title="클릭하면 요청 상세(헤더, Request/Response Body)를 봅니다"
      onClick={() => openRequest(record, focus)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openRequest(record, focus);
      }}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </div>
  );
};

// 아주 큰 응답을 그대로 그리면 패널이 멈추므로 상세 화면에서는 이만큼만 보여 준다(복사도 같은 내용).
const MAX_DETAIL_TEXT = 200_000;

const prettyText = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

const copyText = (text: string) => {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // 클립보드를 못 쓰는 환경이면 넘어간다.
  }
};

// 앱의 전역 CSS(pre, summary 색 등)가 패널에 새어 들지 않도록 색을 직접 지정한다.
const preStyle: CSSProperties = {
  color: color.text,
  margin: '4px 0',
  padding: 6,
  maxHeight: 280,
  overflow: 'auto',
  background: color.panel,
  borderRadius: 4,
  whiteSpace: 'pre-wrap',
  font: 'inherit',
};

const Section = ({ title, children, copy }: { title: string; children: ReactNode; copy?: string }) => (
  <details open style={{ marginTop: 6 }}>
    <summary style={{ cursor: 'pointer', color: '#93c5fd' }}>
      {title}
      {copy !== undefined && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            copyText(copy);
          }}
          style={{ marginLeft: 8, background: 'none', border: `1px solid ${color.border}`, borderRadius: 4, color: color.muted, font: 'inherit', cursor: 'pointer' }}
        >
          복사
        </button>
      )}
    </summary>
    {children}
  </details>
);

const KeyValues = ({ values }: { values?: Record<string, string> }) =>
  values && Object.keys(values).length > 0 ? (
    <div style={preStyle}>
      {Object.entries(values).map(([k, v]) => (
        <div key={k}>
          <span style={{ color: color.muted }}>{k}:</span> {v}
        </div>
      ))}
    </div>
  ) : (
    <div style={{ color: color.muted }}>(없음)</div>
  );

const queryParamsOf = (url: string): Record<string, string> | undefined => {
  try {
    const params = new URL(url, location.href).searchParams;
    const result: Record<string, string> = {};
    params.forEach((v, k) => {
      result[k] = result[k] === undefined ? v : `${result[k]}, ${v}`;
    });
    return result;
  } catch {
    return undefined;
  }
};

/** 이 요청의 데이터를 쓰는 컴포넌트를 이름별로 센다. 호버하면 화면에서 강조한다. */
const ConsumerList = ({ record }: { record: RequestRecord }) => {
  const hoverRequest = useContext(HoverRequestContext);
  const [consumers] = useState(() => findConsumers(record, (el) => isOwnUi(el)));
  const counts = new Map<string, { count: number; via: string }>();
  for (const c of consumers) counts.set(c.name, { count: (counts.get(c.name)?.count ?? 0) + 1, via: c.via });
  return (
    <Section title={`이 요청의 데이터를 쓰는 컴포넌트 (${consumers.length})`}>
      <div onMouseEnter={() => hoverRequest(record)} onMouseLeave={() => hoverRequest(null)} style={preStyle}>
        {consumers.length === 0 && <div style={{ color: color.muted }}>지금 화면에서 이 응답 객체를 들고 있는 컴포넌트를 찾지 못했습니다(가공된 데이터일 수 있습니다).</div>}
        {Array.from(counts).map(([name, { count, via }]) => (
          <div key={name}>
            &lt;{name}&gt; {count > 1 && `× ${count}`} <span style={{ color: color.muted }}>← {via}</span>
          </div>
        ))}
        {consumers.length > 0 && <div style={{ color: color.muted }}>여기에 마우스를 올리면 화면에서 강조합니다.</div>}
      </div>
    </Section>
  );
};

export const RequestDetail = ({ record, focus, onBack }: { record: RequestRecord; focus?: Focus; onBack: () => void }) => {
  const requestBody = record.requestBody !== undefined ? prettyText(record.requestBody) : undefined;
  // 파싱된 응답 객체가 있으면 그것을 정렬해 보여 준다. 원문은 100KB 에서 잘려 JSON 으로 다시 읽히지 않을 수 있다.
  const responseBody =
    record.body !== undefined ? truncate(JSON.stringify(record.body, null, 2) ?? '', MAX_DETAIL_TEXT) : record.responseText !== undefined ? prettyText(record.responseText) : undefined;
  return (
    <div>
      <Button onClick={onBack}>← 뒤로</Button>
      <div style={{ marginTop: 8 }}>
        <b>{record.method}</b> {record.url}
      </div>
      <div style={{ color: record.error || record.status >= 400 ? color.warn : color.muted }}>
        {record.kind} · {record.error ? `실패 (${record.error})` : record.status} · {record.durationMs}ms · {new Date(record.startedAt).toLocaleTimeString()}
      </div>
      <div style={{ marginTop: 4 }}>
        <ClassBadge record={record} />
        {record.duplicateOf && <span style={{ color: color.muted }}>앞선 요청 #{record.duplicateOf} </span>}
        {record.sameResponseAs && <span style={{ color: color.muted }}>같은 응답 #{record.sameResponseAs}</span>}
      </div>
      {focus && (
        <Section title={`이 컴포넌트가 쓰는 데이터: ${focus.path} ← ${focus.via}`}>
          <pre style={preStyle}>{JSON.stringify(valueAt(record.body, focus.path), null, 2) ?? '(값 없음)'}</pre>
        </Section>
      )}
      {record.trigger && (
        <div style={{ color: color.muted, marginTop: 4 }}>
          {record.trigger === 'focus' ? '창 포커스·탭 전환 직후에 나간 요청입니다(라이브러리의 자동 재요청).' : '네트워크 재연결 직후에 나간 요청입니다.'}
        </div>
      )}
      <ConsumerList record={record} />
      {record.stack && (
        <Section title="요청을 보낸 코드" copy={record.stack}>
          <pre style={preStyle}>{record.stack}</pre>
        </Section>
      )}
      <Section title="Query">
        <KeyValues values={queryParamsOf(record.url)} />
      </Section>
      <Section title="Request Headers">
        <KeyValues values={record.requestHeaders} />
      </Section>
      <Section title="Request Body" copy={requestBody}>
        {record.bodyUnreadable ? (
          <div style={{ color: color.muted }}>(Blob·스트림처럼 바로 읽을 수 없는 본문)</div>
        ) : requestBody !== undefined ? (
          <pre style={preStyle}>{requestBody}</pre>
        ) : (
          <div style={{ color: color.muted }}>(없음)</div>
        )}
      </Section>
      <Section title="Response Headers">
        <KeyValues values={record.responseHeaders} />
      </Section>
      <Section title="Response Body" copy={responseBody}>
        {responseBody !== undefined ? (
          <pre style={preStyle}>{responseBody}</pre>
        ) : (
          <div style={{ color: color.muted }}>(텍스트가 아닌 응답이거나 아직 받지 못했습니다)</div>
        )}
      </Section>
    </div>
  );
};

// ---- 요청 감시 지표 ----

interface EndpointStat {
  endpoint: string;
  count: number;
  /** 낭비로 판정된 중복 요청 */
  duplicates: number;
  /** 낭비로 판정된 같은 응답 재요청 */
  sameResponses: number;
  /** 주기 요청·포커스 재요청처럼 의도된 듯하지만 점검할 만한 반복 */
  review: number;
  /** StrictMode·재연결·무시처럼 이유가 확실한 반복 */
  explained: number;
  avgMs: number;
}

const getEndpointStats = (records: readonly RequestRecord[], classes: Map<number, RequestClass>): EndpointStat[] => {
  const map = new Map<string, EndpointStat & { totalMs: number }>();
  for (const r of records) {
    const endpoint = endpointOf(r);
    const s = map.get(endpoint) ?? { endpoint, count: 0, duplicates: 0, sameResponses: 0, review: 0, explained: 0, avgMs: 0, totalMs: 0 };
    s.count++;
    s.totalMs += r.durationMs;
    const c = classes.get(r.id);
    if (c === 'duplicate') s.duplicates++;
    else if (c === 'same-response') s.sameResponses++;
    else if (needsReview(c)) s.review++;
    else if (c && c !== 'ok') s.explained++;
    map.set(endpoint, s);
  }
  return Array.from(map.values())
    .map((s) => ({ ...s, avgMs: Math.round(s.totalMs / s.count) }))
    .sort((a, b) => b.duplicates + b.sameResponses - (a.duplicates + a.sameResponses) || b.count - a.count);
};

const isWasteful = (stat: EndpointStat | undefined) => !!stat && (stat.duplicates > 0 || stat.sameResponses > 0);

// 요청이 몰려도 패널은 한 프레임에 한 번만 다시 그린다. 버전 숫자만 구독한다.
let recordsVersion = 0;
const subscribeRecords = (cb: () => void) => {
  let frame = 0;
  const unsubscribe = subscribe(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      recordsVersion++;
      cb();
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    unsubscribe();
  };
};

const useRecords = () => useSyncExternalStore(subscribeRecords, () => recordsVersion);

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
    <ClassBadge record={record} />
    {stat && stat.count > 1 && <Badge c={isWasteful(stat) ? color.warn : color.muted}>최근 {stat.count}회 호출</Badge>}
  </>
);

const HitRow = ({ hit, stats }: { hit: Hit; stats: Map<string, EndpointStat> }) => (
  <div style={{ padding: '6px 0', borderTop: `1px solid ${color.border}` }}>
    <RequestLink record={hit.record} focus={{ path: hit.path, via: hit.via }}>
      <div>
        <Badge c={MATCH_COLOR[hit.match]}>{MATCH_LABEL[hit.match]}</Badge>
        <u>
          {hit.record.method} {shortUrl(hit.record.url)}
        </u>
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
      <div style={{ color: color.accent }}>클릭하면 요청 상세와 전체 값을 봅니다</div>
    </RequestLink>
  </div>
);

// ---- 탭 ----

const InspectTab = ({ result, stats }: { result: InspectResult | null; stats: Map<string, EndpointStat> }) => {
  if (!result) return <div style={{ color: color.muted }}>[요소 선택]을 누르고 화면의 요소를 클릭하면, 그 요소의 데이터가 어느 API 응답에서 왔는지 보여 줍니다.</div>;
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

const RequestsTab = ({
  records,
  stats,
  ignored,
  onToggleIgnore,
}: {
  records: readonly RequestRecord[];
  stats: EndpointStat[];
  ignored: ReadonlySet<string>;
  onToggleIgnore: (endpoint: string) => void;
}) => {
  const [view, setView] = useState<'endpoints' | 'log'>('endpoints');
  // 엔드포인트를 누르면 그 엔드포인트의 요청만 전체 기록에 보여 준다.
  const [filter, setFilter] = useState<string | null>(null);
  const logs = [...records].reverse().filter((r) => !filter || endpointOf(r) === filter);
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <Button active={view === 'endpoints'} onClick={() => setView('endpoints')}>
          엔드포인트별
        </Button>
        <Button active={view === 'log'} onClick={() => setView('log')}>
          전체 기록
        </Button>
        {view === 'log' && filter && (
          <Button onClick={() => setFilter(null)} title="필터 해제">
            {filter} ✕
          </Button>
        )}
        <span style={{ color: color.muted, marginLeft: 'auto' }}>최근 {records.length}건</span>
      </div>
      {view === 'endpoints'
        ? stats.map((s) => (
            <div
              key={s.endpoint}
              role="button"
              tabIndex={0}
              title="이 엔드포인트의 요청 목록 보기"
              onClick={() => {
                setFilter(s.endpoint);
                setView('log');
              }}
              style={{ padding: '4px 0', borderTop: `1px solid ${color.border}`, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: isWasteful(s) ? color.warn : ignored.has(s.endpoint) ? color.muted : color.text, flex: 1 }}>
                  <u>{s.endpoint}</u>
                </span>
                <button
                  type="button"
                  title="이 엔드포인트의 중복·같은 응답을 낭비로 세지 않습니다(의도된 동작일 때)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleIgnore(s.endpoint);
                  }}
                  style={{ background: 'none', border: `1px solid ${color.border}`, borderRadius: 4, color: color.muted, font: 'inherit', cursor: 'pointer' }}
                >
                  {ignored.has(s.endpoint) ? '무시 해제' : '무시'}
                </button>
              </div>
              <div style={{ color: color.muted }}>
                {s.count}회 · 평균 {s.avgMs}ms
                {s.duplicates > 0 && <span style={{ color: color.warn }}> · 중복 {s.duplicates}</span>}
                {s.sameResponses > 0 && <span style={{ color: color.warn }}> · 같은 응답 {s.sameResponses}</span>}
                {s.review > 0 && <span style={{ color: color.review }}> · 확인 필요 {s.review}</span>}
                {s.explained > 0 && <span> · 정상 반복 {s.explained}</span>}
              </div>
            </div>
          ))
        : logs.map((r) => (
            <div key={r.id} style={{ padding: '4px 0', borderTop: `1px solid ${color.border}` }}>
              <RequestLink record={r}>
                <div>
                  <u>
                    {r.method} {shortUrl(r.url)}
                  </u>
                </div>
                <div style={{ color: r.error ? color.warn : color.muted }}>
                  {r.kind} · {r.error ? `실패 (${r.error})` : r.status} · {r.durationMs}ms · {new Date(r.startedAt).toLocaleTimeString()}{' '}
                  <ClassBadge record={r} short />
                </div>
                <RequestParams record={r} />
              </RequestLink>
            </div>
          ))}
    </div>
  );
};

type RenderSort = 'count' | 'time' | 'avoidable';

const REASON_LABEL: Record<RenderReason, string> = {
  mount: 'mount',
  state: 'state',
  context: 'context',
  props: 'props',
  'same-content': '같은 내용 새 참조',
  'new-callback': '새 콜백',
  parent: '부모 렌더',
};

interface RenderGroup extends RenderSummary {
  name: string;
  instances: number;
  fiber: unknown;
}

const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));

/** 같은 컴포넌트가 여러 개 렌더되면(목록의 행 등) 이름별로 합친다. */
const groupRenders = (): RenderGroup[] => {
  const grouped = new Map<string, RenderGroup>();
  for (const e of getTopRenders(500)) {
    const g = grouped.get(e.name);
    if (!g) {
      grouped.set(e.name, { ...e, reasons: { ...e.reasons }, causes: e.causes.map((c) => ({ ...c })), instances: 1 });
      continue;
    }
    g.recent += e.recent;
    g.ms += e.ms;
    g.avoidable += e.avoidable;
    g.network += e.network;
    g.instances++;
    for (const r of Object.keys(g.reasons) as RenderReason[]) g.reasons[r] += e.reasons[r];
    g.sameContentKeys = union(g.sameContentKeys, e.sameContentKeys);
    g.callbackKeys = union(g.callbackKeys, e.callbackKeys);
    g.contextKeys = union(g.contextKeys, e.contextKeys);
    for (const c of e.causes) {
      const same = g.causes.find((x) => endpointOf(x.record) === endpointOf(c.record));
      if (same) {
        same.direct += c.direct;
        same.parent += c.parent;
      } else g.causes.push({ ...c });
    }
  }
  return Array.from(grouped.values());
};

const propsList = (keys: string[]) => keys.map((k) => `props.${k}`).join(', ');

/** 줄일 수 있거나 점검할 렌더가 있으면 어떻게 줄일지 알려 준다. 렌더는 네트워크와 무관하게도 비효율적일 수 있다. */
const renderAdvice = (g: RenderGroup): string[] => {
  const advice: string[] = [];
  if (g.reasons['same-content'] > 0) {
    advice.push(`${propsList(g.sameContentKeys)} 가 내용은 같은데 새 객체로 내려옵니다. 부모에서 useMemo 로 참조를 유지하거나, 응답을 구조적 공유(React Query select 등)로 받으세요.`);
  }
  if (g.reasons['new-callback'] > 0) {
    advice.push(`${propsList(g.callbackKeys)} 에 렌더마다 새 함수가 내려옵니다. 부모에서 useCallback 으로 감싸세요.`);
  }
  if (g.reasons.parent > 0 && !g.memoized) {
    advice.push('props·state·context 가 그대로인데 부모가 렌더돼서 같이 렌더됐습니다. React.memo 로 감싸면 줄일 수 있습니다.');
  }
  if (g.reasons.context > 0) {
    advice.push(`읽고 있는 context(${g.contextKeys.join(', ')}) 값이 바뀌어 렌더됐습니다. React.memo 로는 줄지 않습니다. 자주 바뀌는 값과 아닌 값을 다른 context 로 나누거나, Provider 의 value 를 useMemo 로 감싸세요.`);
  }
  return advice;
};

const RendersTab = ({ statsByEndpoint }: { statsByEndpoint: Map<string, EndpointStat> }) => {
  const [, setTick] = useState(0);
  const [sort, setSort] = useState<RenderSort>('avoidable');
  useEffect(() => {
    setRenderMonitoring(true);
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      window.clearInterval(timer);
      setRenderMonitoring(false);
    };
  }, []);
  const key = (g: RenderGroup) => (sort === 'time' ? g.ms : sort === 'avoidable' ? g.avoidable * 1000 + g.recent : g.recent);
  const top = groupRenders()
    .sort((a, b) => key(b) - key(a))
    .slice(0, 30);
  const hasTiming = top.some((g) => g.ms > 0);
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ color: color.muted }}>렌더 분석 · 최근 10초 ·</span>
        <Button active={sort === 'avoidable'} onClick={() => setSort('avoidable')} title="줄일 수 있는 렌더(같은 내용 새 참조, 부모/context)가 많은 순">
          줄일 수 있는 렌더순
        </Button>
        <Button active={sort === 'count'} onClick={() => setSort('count')}>
          횟수순
        </Button>
        <Button active={sort === 'time'} onClick={() => setSort('time')} title="자식을 뺀 자기 자신의 렌더 시간 합">
          시간순
        </Button>
      </div>
      {top.length === 0 && <div style={{ color: color.muted }}>아직 렌더가 없습니다. 화면을 조작해 보세요.</div>}
      {top.map((g, i) => {
        // 렌더가 잦은 컴포넌트가 어떤 요청의 데이터를 쓰는지 같이 보여 준다.
        const hit = inspectFiber(g.fiber as never)[0];
        const stat = hit ? statsByEndpoint.get(endpointOf(hit.record)) : undefined;
        const advice = renderAdvice(g);
        const nonNetwork = g.recent - g.network;
        return (
          <div key={i} style={{ padding: '4px 0', borderTop: `1px solid ${color.border}` }}>
            <div>
              <b style={{ color: g.recent / g.instances >= 10 ? color.warn : color.text }}>{g.recent}회</b>
              {hasTiming && <span style={{ color: color.muted }}> · {g.ms.toFixed(1)}ms</span>} &lt;{g.name}&gt;
              {g.instances > 1 && <span style={{ color: color.muted }}> × {g.instances}개</span>}
              {g.avoidable > 0 && <Badge c={color.review}>줄일 수 있음 {g.avoidable}</Badge>}
            </div>
            <div style={{ color: color.muted }}>
              {(Object.keys(g.reasons) as RenderReason[])
                .filter((r) => g.reasons[r] > 0)
                .map((r) => `${REASON_LABEL[r]} ${g.reasons[r]}`)
                .join(' · ')}
            </div>
            {advice.map((text, j) => (
              <div key={j} style={{ color: color.review }}>
                · {text}
              </div>
            ))}
            {/* 렌더는 네트워크와 무관할 수 있다. 응답 객체로 근거가 확인된 것만 네트워크 원인으로 보여 준다. */}
            <div style={{ color: color.muted }}>
              네트워크 응답으로 {g.network}회 · 네트워크와 무관 {nonNetwork}회
            </div>
            {g.causes.slice(0, 3).map((c, j) => (
              <RequestLink key={j} record={c.record}>
                <div style={{ color: color.muted }}>
                  ⇠ <u>{c.record.method} {shortUrl(c.record.url)}</u> 응답으로 렌더 {c.direct + c.parent}회
                  {c.parent > 0 && ` (그중 부모를 따라 ${c.parent}회)`} <ClassBadge record={c.record} />
                </div>
              </RequestLink>
            ))}
            {hit && (
              <RequestLink record={hit.record}>
                <div style={{ color: color.muted }}>
                  데이터 출처 ← <u>{hit.record.method} {shortUrl(hit.record.url)}</u> <ClassBadge record={hit.record} />
                  {stat && stat.duplicates > 0 && <Badge c={color.warn}>중복 {stat.duplicates}</Badge>}
                  {stat && stat.sameResponses > 0 && <Badge c={color.warn}>같은 응답 {stat.sameResponses}</Badge>}
                </div>
              </RequestLink>
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
  const [hovered, setHovered] = useState<{ record: RequestRecord; x: number; y: number } | null>(null);
  const openRequest = useContext(OpenRequestContext);
  const hoverRequest = useContext(HoverRequestContext);
  const classOf = useContext(ClassContext);
  // 도킹 방식에 따라 패널 너비가 달라지므로 그릴 때마다 실제 너비를 잰다.
  const boxRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(456);
  useEffect(() => {
    setRenderMonitoring(true);
    return () => setRenderMonitoring(false);
  }, []);
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (boxRef.current) setMeasured(boxRef.current.clientWidth);
    }, 500);
    return () => window.clearInterval(timer);
  }, [paused]);

  const width = Math.max(240, measured);
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
        <span>네트워크 타임라인 · 최근 20초</span>
        <span>
          <span style={{ color: color.accent }}>■</span> 요청 <span style={{ color: color.warn }}>■</span> 낭비 <span style={{ color: color.review }}>■</span> 확인 필요(주기·포커스){' '}
          <span style={{ color: color.muted }}>■</span> 정상 반복{' '}
          <span style={{ color: '#fb923c' }}>■</span> 실패{' '}
          <span style={{ color: '#a78bfa' }}>▮</span> 비교용 렌더 commit(높이 = 렌더된 컴포넌트 수, 자세히는 렌더 › 분석)
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button active={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ 재개' : '❚❚ 멈춤'}
          </Button>
        </span>
      </div>
      <div ref={boxRef} style={{ position: 'relative' }} onMouseLeave={() => setHovered(null)}>
      <svg width={width} height={height} style={{ display: 'block', background: color.panel, borderRadius: 4 }}>
        {bursts.map((b, i) => {
          // 페이지 진입 직후의 동시 요청은 흔하지만, 수십 건이 쏟아지는 것은 성능 문제일 수 있어 노랑(확인 필요)으로 둔다.
          const initial = isInitialLoad(b.from);
          const c = initial ? color.review : color.warn;
          return (
            <g key={`b${i}`}>
              <rect x={x(b.from) - 2} y={0} width={Math.max(4, x(b.to) - x(b.from) + 4)} height={height - 14} fill={c} opacity={initial ? 0.1 : 0.18} />
              <text x={x(b.from)} y={height - 16} fill={c} fontSize={10}>
                {initial ? '첫 로딩 몰림' : '요청 몰림'} {b.count}건
              </text>
            </g>
          );
        })}
        {bars.map(({ r, lane }) => {
          const c = classOf(r);
          const fill = r.error ? '#fb923c' : c === 'ok' ? color.accent : classColor(c);
          return (
            <rect
              key={r.id}
              x={x(r.startedAt)}
              y={lane * (LANE_H + 2) + 2}
              width={Math.max(3, x(r.startedAt + r.durationMs) - x(r.startedAt))}
              height={LANE_H}
              fill={fill}
              stroke={hovered?.record === r ? '#fff' : undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => {
                setHovered({ record: r, x: x(r.startedAt), y: lane * (LANE_H + 2) + LANE_H + 6 });
                hoverRequest(r);
              }}
              onMouseLeave={() => hoverRequest(null)}
              onClick={() => openRequest(r)}
            />
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
      {hovered && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(hovered.x, width - 300),
            top: hovered.y,
            width: 300,
            padding: 6,
            background: '#000',
            border: `1px solid ${color.border}`,
            borderRadius: 4,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          <div>
            <b>{hovered.record.method}</b> {shortUrl(hovered.record.url)}
          </div>
          <div style={{ color: color.muted }}>
            {hovered.record.error ? `실패 (${hovered.record.error})` : hovered.record.status} · {hovered.record.durationMs}ms ·{' '}
            {new Date(hovered.record.startedAt).toLocaleTimeString()}
          </div>
          <RequestParams record={hovered.record} />
          <div>
            <ClassBadge record={hovered.record} />
          </div>
          <div style={{ color: color.accent }}>클릭하면 상세 보기</div>
        </div>
      )}
      </div>
      <div style={{ color: color.muted, marginTop: 6 }}>
        막대에 마우스를 올리면 요청 정보가, 클릭하면 상세(헤더, Request/Response Body)가 보입니다. 요청이 몰린 직후 렌더 눈금이 연달아 찍히면 요청마다 따로 렌더되고 있다는 뜻입니다.
      </div>
    </div>
  );
};

// ---- 요청 → 컴포넌트 강조 ----

const CONSUMER_COLOR = '#fb923c';

/** 호버한 요청의 응답 데이터를 쓰는 컴포넌트를 주황 점선으로 강조한다. */
const ConsumerHighlight = ({ record }: { record: RequestRecord }) => {
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  useEffect(() => setConsumers(findConsumers(record, (el) => isOwnUi(el))), [record]);
  return (
    <>
      {consumers.map(
        (c, i) =>
          c.rect && (
            <div
              key={i}
              style={{
                position: 'fixed',
                left: c.rect.left,
                top: c.rect.top,
                width: c.rect.width,
                height: c.rect.height,
                outline: `2px dashed ${CONSUMER_COLOR}`,
                background: `${CONSUMER_COLOR}1f`,
                pointerEvents: 'none',
                zIndex: Z - 1,
              }}
            >
              <span style={{ position: 'absolute', right: 0, top: 0, background: CONSUMER_COLOR, color: '#000', font: '10px/1.4 ui-monospace, Menlo, monospace', padding: '0 3px' }}>
                &lt;{c.name}&gt;
              </span>
            </div>
          ),
      )}
    </>
  );
};

// ---- 전체 표시 오버레이 ----

// 렌더 직후 박스를 이만큼 보라색으로 강조한다(React DevTools 의 Highlight updates 처럼).
const FLASH_MS = 600;
// 최근 10초에 이만큼 넘게 렌더되면 렌더 폭주로 보고 숫자를 빨갛게 표시한다.
const RENDER_STORM = 10;
const RENDER_COLOR = '#a78bfa';

const Overlay = () => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  // 박스 위치를 다시 계산하지 않고 깜빡임과 렌더 횟수만 갱신하는 짧은 주기
  const [, setTick] = useState(0);
  const openRequest = useContext(OpenRequestContext);
  const classOf = useContext(ClassContext);
  useEffect(() => {
    // 전체 표시가 켜져 있는 동안 렌더도 센다.
    setRenderMonitoring(true);
    const update = () => setBoxes(collectBoxes((el) => isOwnUi(el)));
    // 스크롤과 commit 은 매우 잦으므로 한 프레임에 한 번만 다시 계산한다.
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const timer = window.setInterval(refresh, 1000);
    const flashTimer = window.setInterval(() => setTick((t) => t + 1), 150);
    const unsubscribe = subscribeCommits(refresh);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.clearInterval(flashTimer);
      unsubscribe();
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
      setRenderMonitoring(false);
    };
  }, []);
  const now = Date.now();
  return (
    <>
      {boxes.map((b, i) => {
        // 같은 엔드포인트의 다른 호출이 아니라, 이 데이터를 준 요청 자체가 낭비였을 때만 빨갛게 그린다.
        const wasteful = isWaste(classOf(b.hit.record));
        const c = wasteful ? color.warn : MATCH_COLOR[b.hit.match];
        const render = getRenderInfo(b.fiber);
        const flashing = !!render && now - render.last < FLASH_MS;
        const storm = !!render && render.recent >= RENDER_STORM;
        return (
          <div
            key={i}
            style={{
              position: 'fixed',
              left: b.rect.left,
              top: b.rect.top,
              width: b.rect.width,
              height: b.rect.height,
              outline: flashing ? `2px solid ${RENDER_COLOR}` : `1px solid ${c}`,
              background: flashing ? `${RENDER_COLOR}33` : `${c}14`,
              pointerEvents: 'none',
              zIndex: Z - 2,
            }}
          >
            <span
              role="button"
              title={`클릭하면 요청 상세를 봅니다${render ? ` · 최근 10초 렌더 ${render.recent}회, 줄일 수 있는 렌더 ${render.avoidable}회` : ''}`}
              onClick={() => openRequest(b.hit.record)}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                cursor: 'pointer',
                pointerEvents: 'auto',
                background: c,
                color: '#000',
                font: '10px/1.4 ui-monospace, Menlo, monospace',
                padding: '0 3px',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                overflow: 'hidden',
              }}
            >
              {render && render.recent > 0 && (
                <b style={{ color: storm ? '#7f1d1d' : '#000', marginRight: 4 }}>
                  ↻{render.recent}
                  {render.avoidable > 0 && `(불필요 ${render.avoidable})`}
                </b>
              )}
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

/** 탭을 영역(데이터·네트워크·렌더)별로 묶어 앞에 영역 이름을 붙인다. */
const TabGroup = ({ label, children }: { label: string; children: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '0 4px', borderLeft: `1px solid ${color.border}` }}>
    <span style={{ color: color.muted, fontSize: 10, marginRight: 2 }}>{label}</span>
    {children}
  </span>
);

// ---- 도킹: 표시 방식 선택, 크기 조절, 별도 창 ----

const DOCK_OPTIONS: Array<{ dock: Dock; icon: string; title: string }> = [
  { dock: 'float', icon: '▭', title: '작게 보기 (버튼 옆)' },
  { dock: 'bottom', icon: '⬓', title: '하단에 도킹 (넓게 보기)' },
  { dock: 'right', icon: '◨', title: '오른쪽에 도킹' },
  { dock: 'window', icon: '⧉', title: '도킹 해제 (별도 창)' },
];

const DockPicker = ({ dock, onChange }: { dock: Dock; onChange: (dock: Dock) => void }) => (
  <span style={{ display: 'inline-flex', gap: 2 }}>
    {DOCK_OPTIONS.map((o) => (
      <Button key={o.dock} active={dock === o.dock} onClick={() => onChange(o.dock)} title={o.title}>
        {o.icon}
      </Button>
    ))}
  </span>
);

/** 도킹한 패널의 안쪽 가장자리를 끌어 높이(하단) 또는 너비(오른쪽)를 바꾼다. */
const ResizeHandle = ({ edge, onResize }: { edge: 'top' | 'left'; onResize: (size: number) => void }) => {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const size = edge === 'top' ? window.innerHeight - ev.clientY : window.innerWidth - ev.clientX;
      const max = (edge === 'top' ? window.innerHeight : window.innerWidth) - 80;
      onResize(Math.min(Math.max(size, 160), max));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      title="끌어서 크기 조절"
      style={
        edge === 'top'
          ? { position: 'absolute', left: 0, right: 0, top: -3, height: 6, cursor: 'ns-resize' }
          : { position: 'absolute', top: 0, bottom: 0, left: -3, width: 6, cursor: 'ew-resize' }
      }
    />
  );
};

/** 도킹 해제: 패널을 별도 창에 그린다. 사용자가 창을 닫으면 onClosed 를 부른다. */
const usePopupWindow = (enabled: boolean, onClosed: () => void): Window | null => {
  const [popup, setPopup] = useState<Window | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => {
    if (!enabled) return;
    const win = window.open('', 'react-data-xray', 'width=960,height=640');
    if (!win) {
      // 팝업이 막히면 작게 보기로 돌아간다.
      onClosedRef.current();
      return;
    }
    win.document.title = 'React Data X-ray';
    win.document.body.style.margin = '0';
    win.document.body.style.background = color.bg;
    setPopup(win);
    // 사용자가 창을 직접 닫았는지 확인한다(다른 창의 unload 이벤트는 브라우저마다 다르게 온다).
    const timer = window.setInterval(() => {
      if (win.closed) onClosedRef.current();
    }, 500);
    return () => {
      window.clearInterval(timer);
      setPopup(null);
      if (!win.closed) win.close();
    };
  }, [enabled]);
  return popup;
};

// ---- 본체 ----

const panelStyle: CSSProperties = {
  position: 'fixed',
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

export const RdxDevtools = ({ hotkey = { key: 'd', shift: true } }: RdxDevtoolsProps) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('inspect');
  const [picking, setPicking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [selected, setSelected] = useState<{ record: RequestRecord; focus?: Focus } | null>(null);
  const [hoveredRecord, setHoveredRecord] = useState<RequestRecord | null>(null);
  const openRequest = (record: RequestRecord, focus?: Focus) => {
    setOpen(true);
    setSelected({ record, focus });
  };
  const { pos, onPointerDown, onPointerMove, onPointerUp } = useDraggable();
  const [dockSettings, setDockSettings] = useState(readDock);
  const { dock } = dockSettings;
  const updateDock = (patch: Partial<DockSettings>) =>
    setDockSettings((prev) => {
      const next = { ...prev, ...patch };
      saveDock(next);
      return next;
    });
  const popup = usePopupWindow(open && dock === 'window', () => updateDock({ dock: 'float' }));
  useRecords();

  const [ignored, setIgnored] = useState(readIgnored);
  const toggleIgnore = (endpoint: string) =>
    setIgnored((prev) => {
      const next = new Set(prev);
      if (next.has(endpoint)) next.delete(endpoint);
      else next.add(endpoint);
      try {
        localStorage.setItem(IGNORE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // 설정 저장은 편의 기능이라 실패해도 넘어간다.
      }
      return next;
    });
  const records = getRecords();
  const classes = classifyRecords(records, ignored);
  const classOf = (record: RequestRecord): RequestClass => classes.get(record.id) ?? 'ok';
  const stats = getEndpointStats(records, classes);
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

  // 작게 보기: 버튼 위쪽(공간이 없으면 아래쪽)에, 화면 밖으로 나가지 않게 둔다.
  const panelLeft = clamp(pos.x + 44 - 480, window.innerWidth - 480);
  const floatPos: CSSProperties =
    pos.y > window.innerHeight / 2 ? { left: panelLeft, bottom: window.innerHeight - pos.y + 8 } : { left: panelLeft, top: pos.y + 52 };
  const dockStyle: CSSProperties =
    dock === 'bottom'
      ? { left: 0, right: 0, bottom: 0, height: dockSettings.bottomHeight, borderTop: `1px solid ${color.border}` }
      : dock === 'right'
        ? { top: 0, right: 0, bottom: 0, width: dockSettings.rightWidth, borderLeft: `1px solid ${color.border}` }
        : dock === 'window'
          ? { position: 'static', width: '100%', height: '100vh' }
          : { ...floatPos, width: 480, maxHeight: '70vh', borderRadius: 8, boxShadow: '0 4px 24px rgba(0,0,0,.4)' };

  const panel = (
    <div style={{ ...panelStyle, ...dockStyle }} role="dialog" aria-label="React Data X-ray" {...{ [ROOT_ATTR]: '' }}>
      {(dock === 'bottom' || dock === 'right') && (
        <ResizeHandle
          edge={dock === 'bottom' ? 'top' : 'left'}
          onResize={(size) => updateDock(dock === 'bottom' ? { bottomHeight: size } : { rightWidth: size })}
        />
      )}
      <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: `1px solid ${color.border}`, flexWrap: 'wrap' }}>
        {/* 별도 창으로 띄워도 요소 선택과 전체 표시는 원래 창의 화면에 동작한다. */}
        <Button
          active={picking}
          onClick={() => (picking ? setPicking(false) : startPicking())}
          title={dock === 'window' ? '원래 창에서 요소를 클릭하세요' : `요소 선택 (Ctrl/Cmd+Shift+${hotkey.key.toUpperCase()})`}
        >
          ⌖ 요소 선택
        </Button>
        <Button active={showAll} onClick={() => setShowAll((v) => !v)} title="데이터 출처가 있는 요소를 모두 표시">
          ▦ 전체 표시
        </Button>
        <span style={{ flex: 1 }} />
        {/* 네트워크와 렌더는 따로 보는 영역이라, 탭을 영역별로 묶어 어느 쪽을 보고 있는지 헷갈리지 않게 한다. */}
        <TabGroup label="데이터">
          <Button active={tab === 'inspect' && !selected} onClick={() => (setTab('inspect'), setSelected(null))} title="요소를 클릭해 어느 API 응답의 데이터인지 봅니다">
            출처
          </Button>
        </TabGroup>
        <TabGroup label="네트워크">
          <Button active={tab === 'requests' && !selected} onClick={() => (setTab('requests'), setSelected(null))} title="네트워크 요청 목록과 엔드포인트별 낭비 지표">
            요청{wastefulCount > 0 ? ` ⚠${wastefulCount}` : ''}
          </Button>
          <Button active={tab === 'timeline' && !selected} onClick={() => (setTab('timeline'), setSelected(null))} title="네트워크 요청을 시간축에 놓고, 비교용으로 렌더 commit 을 함께 보여 줍니다">
            타임라인
          </Button>
        </TabGroup>
        <TabGroup label="렌더">
          <Button active={tab === 'renders' && !selected} onClick={() => (setTab('renders'), setSelected(null))} title="렌더 횟수, 이유, 줄일 수 있는 렌더">
            분석
          </Button>
        </TabGroup>
        <span style={{ width: 8 }} />
        <DockPicker dock={dock} onChange={(next) => updateDock({ dock: next })} />
        <Button onClick={() => setOpen(false)} title="닫기">
          ✕
        </Button>
      </div>
      <div style={{ padding: 8, overflow: 'auto', flex: 1 }}>
        {picking && <div style={{ color: color.accent, marginBottom: 8 }}>화면의 요소를 클릭하세요. (Esc 취소)</div>}
        {selected && <RequestDetail record={selected.record} focus={selected.focus} onBack={() => setSelected(null)} />}
        {/* 상세를 여는 동안에도 탭 상태(필터, 타임라인 멈춤 등)를 잃지 않도록 숨기기만 한다. */}
        <div style={{ display: selected ? 'none' : undefined }}>
          {tab === 'inspect' && <InspectTab result={result} stats={statsByEndpoint} />}
          {tab === 'requests' && <RequestsTab records={records} stats={stats} ignored={ignored} onToggleIgnore={toggleIgnore} />}
          {tab === 'timeline' && <TimelineTab records={records} />}
          {tab === 'renders' && <RendersTab statsByEndpoint={statsByEndpoint} />}
        </div>
      </div>
    </div>
  );

  return createPortal(
    <ClassContext.Provider value={classOf}>
    <HoverRequestContext.Provider value={setHoveredRecord}>
    <OpenRequestContext.Provider value={openRequest}>
    <div {...{ [ROOT_ATTR]: '' }}>
      {showAll && <Overlay />}
      {hoveredRecord && <ConsumerHighlight record={hoveredRecord} />}
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
      {open && dock !== 'window' && panel}
      {open && dock === 'window' && popup && createPortal(panel, popup.document.body)}
      <button
        type="button"
        aria-label="React Data X-ray 열기"
        title="React Data X-ray (드래그로 이동)"
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
        RDX
      </button>
    </div>
    </OpenRequestContext.Provider>
    </HoverRequestContext.Provider>
    </ClassContext.Provider>,
    document.body,
  );
};

