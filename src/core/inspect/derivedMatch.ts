import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import { getRecords, getStoreVersion } from '../requests/store.js';
import type { Origin, RequestRecord } from '../requests/types.js';

// 이만큼의 필드 값이 같아야 같은 데이터를 가공한 객체로 본다.
const MIN_DERIVED_FIELDS = 2;

/** 우연히 같기 어려운 값만 쓴다(짧은 문자열, 작은 숫자, boolean 은 뺀다). */
const isDistinctive = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.length >= 2 && v.length <= 200) || (typeof v === 'number' && Math.abs(v) >= 10);

const fieldKey = (name: string, value: string | number) => `${name}\u0000${value}`;

// 응답을 펼쳐 복사하고 필드 하나를 덧붙인 객체({...json, before})는 값이 작은 숫자뿐이면 위 기준으로 못 찾는다.
// 원시값 필드가 이만큼 이상이고 그 이름 묶음과 값이 모두 같으면 같은 데이터로 본다.
const MIN_SHAPE_FIELDS = 3;

const isPrimitive = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** 원시값 필드 이름 묶음. 객체·배열 필드(덧붙인 before 같은)는 뺀다. 필드가 적으면 null */
const shapeKeyOf = (value: object): string | null => {
  const names = Object.keys(value).filter((k) => isPrimitive((value as Record<string, unknown>)[k]));
  return names.length >= MIN_SHAPE_FIELDS ? `\u0001${names.sort().join('\u0000')}` : null;
};

/** 색인 항목: 응답 안의 객체와 그 위치 */
interface IndexEntry {
  origin: Origin;
  node: Record<string, unknown>;
}

// 이보다 많은 객체가 가진 값(status: 'ACTIVE' 같은)은 후보를 뽑는 데 쓰지 않는다. 점수를 셀 때만 쓴다.
const MAX_CANDIDATES_PER_FIELD = 1000;

// 수백 KB 응답도 있어 색인 작업을 이만큼씩 끊어서 한다. 한 번에 다 하면 메인 스레드를 수백 ms 막는다.
const SLICE_MS = 8;
const NODES_PER_STEP = 200;

const addEntry = (index: Segment, key: string, entry: IndexEntry): void => {
  const list = index.get(key);
  // 같은 값이 수천 번 나오므로 목록을 복사하지 않고 붙인다.
  if (list) list.push(entry);
  else index.set(key, [entry]);
};

/** 응답 하나의 "필드명=값" 과 원시값 필드 이름 묶음을 색인에 더한다. NODES_PER_STEP 노드마다 멈춰 다른 일을 끼워 넣을 수 있게 한다. */
function* indexRecord(index: Segment, record: RequestRecord): Generator<void, void, void> {
  const stack: Array<[unknown, string]> = record.body !== null && typeof record.body === 'object' ? [[record.body, '$']] : [];
  for (let nodes = 0; stack.length > 0 && nodes <= MAX_NODES_PER_BODY; nodes++) {
    if (nodes % NODES_PER_STEP === 0) yield;
    const [value, path] = stack.pop()!;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') stack.push([v, `${path}[${i}]`]);
      });
      continue;
    }
    const entry: IndexEntry = { origin: { record, path }, node: value as Record<string, unknown> };
    const shape = shapeKeyOf(value as object);
    if (shape) addEntry(index, shape, entry);
    Object.entries(value as object).forEach(([k, v]) => {
      if (!isDistinctive(v)) {
        if (v !== null && typeof v === 'object') stack.push([v, `${path}.${k}`]);
        return;
      }
      addEntry(index, fieldKey(k, v), entry);
    });
  }
}

// 응답마다 따로 색인한다. 목록에서 밀려난 응답은 그 조각만 버리면 되므로, 색인이 응답을 더 오래 붙잡지 않는다
// (하나로 합친 색인은 밀려난 응답의 객체를 계속 쥐고 있어 1MB 응답이 쌓이면 힙이 수백 MB 가 됐다).
// 전체 표시는 props 객체 수천 개를 한 번에 조회하므로, 기록이 그대로면 아무것도 다시 하지 않는다.
type Segment = Map<string, IndexEntry[]>;

const cache = {
  segments: new Map<RequestRecord, Segment>(),
  version: -1,
  // 남은 색인 작업. 응답마다 하나씩, 들어온 순서대로 한다.
  queue: [] as Array<{ record: RequestRecord; work: Generator<void, void, void> }>,
  timer: 0,
};

/** 남은 색인 작업을 limitMs 동안 한다. 남으면 백그라운드에서 SLICE_MS 씩 이어 한다. 작은 응답은 첫 조각 안에 끝난다. */
const runQueue = (limitMs = SLICE_MS): void => {
  const started = performance.now();
  while (cache.queue.length > 0 && performance.now() - started < limitMs) {
    const { record, work } = cache.queue[0];
    // 색인하는 사이 목록에서 밀려난 응답은 마저 하지 않는다.
    if (!cache.segments.has(record) || work.next().done) cache.queue.shift();
  }
  window.clearTimeout(cache.timer);
  cache.timer = cache.queue.length > 0 ? window.setTimeout(() => runQueue(), 0) : 0;
};

const getSegments = (): ReadonlyMap<RequestRecord, Segment> => {
  if (cache.version === getStoreVersion()) return cache.segments;
  const live = new Set(getRecords());
  cache.segments.forEach((_, record) => {
    if (!live.has(record)) cache.segments.delete(record);
  });
  live.forEach((record) => {
    if (record.body === undefined || cache.segments.has(record)) return;
    const segment: Segment = new Map();
    cache.segments.set(record, segment);
    cache.queue.push({ record, work: indexRecord(segment, record) });
  });
  cache.version = getStoreVersion();
  if (!cache.timer) runQueue();
  return cache.segments;
};

/** 아직 색인하지 못한 응답이 있는지. 있으면 지금 못 찾은 값도 곧 찾을 수 있다. */
export const isIndexPending = (): boolean => cache.queue.length > 0;

// 요소 클릭처럼 한 번 묻고 끝나는 조회가 기다릴 수 있는 시간. 막 도착한 큰 응답 여러 개를 한 번에 다 하면 수백 ms 멈춘다.
const FLUSH_LIMIT_MS = 200;

/** 남은 색인을 FLUSH_LIMIT_MS 까지 지금 한다. 요소 클릭처럼 한 번 묻는 조회는 기다리지 않고 바로 답해야 한다. */
export const flushIndex = (): void => {
  getSegments();
  runQueue(FLUSH_LIMIT_MS);
};

/**
 * 모든 응답 조각에서 "필드명=값" 을 가진 객체 목록들과 그 합계.
 * shortcut: 조회마다 조각(최대 200개)을 돈다. 하나로 합친 색인은 밀려난 응답을 붙잡아 힙이 수백 MB 가 됐다.
 * 프로젝트 목록(기록 200개, 박스 110개)에서 점유율 1% 로 쟀다. 기록 수 상한을 올리면 다시 잰다.
 */
const lookup = (segments: ReadonlyMap<RequestRecord, Segment>, key: string): { parts: IndexEntry[][]; total: number } => {
  const parts: IndexEntry[][] = [];
  let total = 0;
  segments.forEach((segment) => {
    const list = segment.get(key);
    if (!list) return;
    parts.push(list);
    total += list.length;
  });
  return { parts, total };
};

/** 원시값 필드 이름 묶음이 같고 값도 모두 같은 응답 객체(최신 것) */
const findByShape = (segments: ReadonlyMap<RequestRecord, Segment>, value: object): Origin | null => {
  const shape = shapeKeyOf(value);
  if (!shape) return null;
  const { parts, total } = lookup(segments, shape);
  if (total > MAX_CANDIDATES_PER_FIELD) return null;
  const fields = Object.entries(value).filter(([, v]) => isPrimitive(v));
  return parts
    .flat()
    .filter(({ node }) => fields.every(([k, v]) => node[k] === v))
    .reduce<Origin | null>((best, { origin }) => (!best || origin.record.id >= best.record.id ? origin : best), null);
};

/**
 * 우연히 같기 어려운 필드 값이 가장 많이 겹치는 응답 객체를 고른다.
 * 흔한 값의 목록은 수만 개라 다 세면 느리다. 가장 드문 값 두 개를 가진 객체만 후보로 놓고 필드를 직접 비교한다.
 * shortcut: 드문 값 두 개가 모두 엉뚱한 객체와 겹치면 진짜 출처를 놓친다. 놓치는 사례가 나오면 후보 목록 수를 늘린다.
 */
const findByFields = (segments: ReadonlyMap<RequestRecord, Segment>, value: object): Origin | null => {
  const fields = Object.entries(value).filter((entry): entry is [string, string | number] => isDistinctive(entry[1]));
  if (fields.length < MIN_DERIVED_FIELDS) return null;
  // 2개 이상 겹치는 객체는 대개 드문 값 두 개 중 하나를 가진다. 가장 짧은 목록 두 개에서만 후보를 뽑는다.
  const lists = fields
    .map(([k, v]) => lookup(segments, fieldKey(k, v)))
    .filter(({ total }) => total > 0 && total <= MAX_CANDIDATES_PER_FIELD)
    .sort((a, b) => a.total - b.total)
    .slice(0, 2);
  const candidates = new Set(lists.flatMap(({ parts }) => parts.flat()));
  let best: { origin: Origin | null; score: number } = { origin: null, score: 0 };
  candidates.forEach(({ origin, node }) => {
    const score = fields.filter(([k, v]) => node[k] === v).length;
    const newer = !best.origin || origin.record.id >= best.origin.record.id;
    if (score >= MIN_DERIVED_FIELDS && (score > best.score || (score === best.score && newer))) best = { origin, score };
  });
  return best.origin;
};

/** 파생 출처: 드문 값이 겹치는 객체, 없으면 원시값 필드 묶음과 값이 모두 같은 객체 */
const findBest = (value: object): Origin | null => {
  const segments = getSegments();
  return findByFields(segments, value) ?? findByShape(segments, value);
};

// props 객체는 렌더마다 새로 만들어져도 그 안의 값(theme, 상수 style, 응답 항목)은 같은 객체인 경우가 많다.
// 같은 객체는 잠깐 결과를 기억한다. 색인 중에 못 찾은 결과는 기억하지 않는다.
// 기억은 통째로 갈아 끼운다. 항목마다 시각을 두면 오래 사는 객체(theme 등)의 결과가 밀려난 응답을 계속 붙잡는다.
const RESULT_TTL_MS = 3000;
const results = { map: new WeakMap<object, Origin | null>(), since: 0 };

/** 객체의 필드 값과 가장 많이 겹치는(2개 이상) 응답 객체. 같은 점수면 최신 응답을 고른다. */
export const findDerivedOrigin = (value: object): Origin | null => {
  const now = Date.now();
  if (now - results.since >= RESULT_TTL_MS) Object.assign(results, { map: new WeakMap(), since: now });
  if (results.map.has(value)) return results.map.get(value)!;
  const origin = findBest(value);
  if (origin || !isIndexPending()) results.map.set(value, origin);
  return origin;
};
