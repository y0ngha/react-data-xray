import { REPORT_PATH } from '../shared/reportPath.js';
import { maskEndpoint } from './requests/endpointMask.js';

/** `configure()` 가 받는 값. 빠진 값은 기본값이다. */
export interface RdxConfig {
  /**
   * 낭비로 세지 않을 엔드포인트. 문자열은 요청 탭의 엔드포인트 이름(`GET /health`, `GET /items/:id`)과 정확히 같아야 하고,
   * 정규식은 그 이름에 맞춰 본다. 패널에서 고른 무시와 합쳐지고, 패널에서 풀 수 없다.
   */
  ignore?: ReadonlyArray<string | RegExp>;
  /** 같은 요청인지 가를 때 함께 보는 요청 헤더 이름(예: `x-tenant`). 헤더만 다른 요청을 다른 요청으로 센다. */
  keyHeaders?: readonly string[];
  /** 같은 요청이 이 시간(ms) 안에 다시 나가면 중복이다. 기본 2000 */
  dedupeWindowMs?: number;
  /** windowMs 안에 count 건 이상 시작하면 요청 몰림이다. 기본 500ms·5건 */
  burst?: { windowMs?: number; count?: number };
  /** 기억할 요청 수. 넘으면 오래된 것부터 버린다. 기본 200 */
  maxRecords?: number;
  /** 보고서를 보낼 dev 서버 경로. Next.js `basePath` 처럼 앞에 경로가 붙을 때 바꾼다. 기본 `/__rdx/report` */
  reportPath?: string;
}

/** 보고서에 남기는, 지금 적용된 설정 */
export interface EffectiveConfig {
  /** 무시 목록. code 는 configure 의 ignore(정규식은 `/source/flags` 문자열), panel 은 패널에서 고른 엔드포인트. 각각 정렬한다 */
  ignore: { code: string[]; panel: string[] };
  keyHeaders: string[];
  dedupeWindowMs: number;
  burst: { windowMs: number; count: number };
  maxRecords: number;
  reportPath: string;
}

interface Settings {
  ignoreNames: ReadonlySet<string>;
  ignorePatterns: readonly RegExp[];
  keyHeaders: readonly string[];
  dedupeWindowMs: number;
  burstWindowMs: number;
  burstCount: number;
  maxRecords: number;
  reportPath: string;
}

// configure 는 설정을 통째로 바꾸고 고치지 않으므로 기본값 객체 하나를 같이 써도 된다.
const DEFAULTS: Settings = {
  ignoreNames: new Set<string>(),
  ignorePatterns: [],
  keyHeaders: [],
  dedupeWindowMs: 2000,
  burstWindowMs: 500,
  burstCount: 5,
  maxRecords: 200,
  reportPath: REPORT_PATH,
};

/** 기억할 요청 수의 상한. 요청마다 응답 원문(최대 100KB)과 객체를 붙들므로 이보다 크면 힙이 커진다 */
export const MAX_RECORDS_LIMIT = 5000;

interface ConfigState {
  current: Settings;
  /** configure 마다 오른다. 설정으로 계산한 값(패널의 분류)을 다시 계산할지 판단한다 */
  version: number;
  listeners: Set<() => void>;
}

// rdx 가 두 벌 평가되면(#79 의 표식) 처음 것만 설치된다. 어느 사본의 configure 든 설치된 사본에 닿도록 설정은 전역 하나에 둔다.
// 모듈 최상위에서 만들지 않고 처음 읽을 때 만든다(sideEffects).
const STATE = Symbol.for('react-data-xray.config');

const state = (): ConfigState => {
  const g = globalThis as { [STATE]?: ConfigState };
  return (g[STATE] ??= { current: DEFAULTS, version: 0, listeners: new Set() });
};

const replace = (next: Settings): void => {
  const s = state();
  s.current = next;
  s.version++;
  s.listeners.forEach((listener) => listener());
};

/** 판정이 읽는 지금의 설정. 전역 하나를 읽을 뿐이라 앱 경로·유휴 큐에 비용이 없다(O(1)). */
export const config = (): Settings => state().current;

/** configure 할 때마다 오르는 번호 */
export const configVersion = (): number => state().version;

/** configure 될 때 부른다. 해제 함수를 돌려준다 */
export const subscribeConfig = (listener: () => void): (() => void) => {
  const { listeners } = state();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const warn = (message: string): void => console.warn(`[react-data-xray] configure: ${message}`);

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** 받은 값이 맞으면 그 값, 아니면 경고하고 기본값 */
const pick = <T>(value: unknown, ok: (v: unknown) => v is T, fallback: T, name: string, expected: string): T => {
  if (value === undefined) return fallback;
  if (ok(value)) return value;
  warn(`${name} must be ${expected}; got ${String(value)}. Using ${String(fallback)}.`);
  return fallback;
};

// g·y 플래그는 test() 마다 lastIndex 를 옮겨 같은 이름이 번갈아 맞고 안 맞는다. 떼고 복사해 둔다.
const stablePattern = (re: RegExp): RegExp => (/[gy]/.test(re.flags) ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re);

const parseIgnore = (value: unknown): Pick<Settings, 'ignoreNames' | 'ignorePatterns'> => {
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  if (value === undefined) return { ignoreNames: names, ignorePatterns: patterns };
  if (!Array.isArray(value)) {
    warn('ignore must be an array of endpoint names or RegExps; ignoring it.');
    return { ignoreNames: names, ignorePatterns: patterns };
  }
  for (const entry of value as unknown[]) {
    if (entry instanceof RegExp) patterns.push(stablePattern(entry));
    // 엔드포인트 이름은 "메서드 경로" 다. 경로만 쓰면 어느 것과도 맞지 않으므로 알린다.
    else if (typeof entry === 'string' && /^\S+ \S/.test(entry)) names.add(maskEndpoint(entry));
    else
      warn(`ignore entry ${JSON.stringify(entry) ?? String(entry)} is not an endpoint name like 'GET /health' or a RegExp; skipping it.`);
  }
  return { ignoreNames: names, ignorePatterns: patterns };
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

const parseKeyHeaders = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warn('keyHeaders must be an array of header names; ignoring it.');
    return [];
  }
  const names = new Set<string>();
  for (const entry of value as unknown[]) {
    // 기록한 헤더는 소문자 키라 소문자로 맞춘다.
    const name = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (HEADER_NAME.test(name)) names.add(name);
    else warn(`keyHeaders entry ${JSON.stringify(entry) ?? String(entry)} is not a header name; skipping it.`);
  }
  // 순서가 달라도 같은 키가 되게 정렬한다.
  return [...names].sort();
};

const isReportPath = (v: unknown): v is string => typeof v === 'string' && /^\/(?!\/)[^\s?#]*$/.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const capRecords = (n: number): number => {
  if (n <= MAX_RECORDS_LIMIT) return n;
  warn(`maxRecords ${n} is above the limit; using ${MAX_RECORDS_LIMIT}.`);
  return MAX_RECORDS_LIMIT;
};

/**
 * 판정 기준과 무시 목록을 코드에서 정한다. `import 'react-data-xray'` 바로 뒤, 앱이 요청을 보내기 전에 부른다.
 * 부를 때마다 기본값 위에 받은 값을 얹어 통째로 바꾼다(같은 값으로 여러 번 불러도 같다). 맞지 않는 값은 경고하고 기본값을 쓴다.
 */
export const configure = (options: RdxConfig = {}): void => {
  const base = DEFAULTS;
  if (!isObject(options)) {
    warn('options must be an object; using defaults.');
    replace(DEFAULTS);
    return;
  }
  const burst: unknown = options.burst;
  if (burst !== undefined && !isObject(burst)) warn('burst must be an object like { windowMs: 500, count: 5 }; using defaults.');
  const burstOptions = isObject(burst) ? burst : {};
  replace({
    ...parseIgnore(options.ignore),
    keyHeaders: parseKeyHeaders(options.keyHeaders),
    dedupeWindowMs: pick(options.dedupeWindowMs, isNonNegative, base.dedupeWindowMs, 'dedupeWindowMs', 'a number >= 0'),
    burstWindowMs: pick(burstOptions.windowMs, isPositiveInt, base.burstWindowMs, 'burst.windowMs', 'a positive integer'),
    burstCount: pick(burstOptions.count, (v): v is number => isPositiveInt(v) && v >= 2, base.burstCount, 'burst.count', 'an integer >= 2'),
    maxRecords: capRecords(pick(options.maxRecords, isPositiveInt, base.maxRecords, 'maxRecords', 'a positive integer')),
    reportPath: pick(options.reportPath, isReportPath, base.reportPath, 'reportPath', "a path starting with '/' (no query)"),
  });
};

/** 테스트에서 기본값으로 되돌린다. */
export const resetConfig = (): void => replace(DEFAULTS);

/** 코드(configure)의 무시 목록에 든 엔드포인트인지. 패널에서 풀 수 없다. */
export const isConfigIgnored = (endpoint: string): boolean => {
  const { ignoreNames, ignorePatterns } = config();
  return ignoreNames.has(endpoint) || ignorePatterns.some((re) => re.test(endpoint));
};

/** 보고서에 남길, 지금 적용된 설정. panel 은 패널에서 고른 무시(보고서를 만들 때 넘긴다) */
export const effectiveConfig = (panel: ReadonlySet<string> = new Set()): EffectiveConfig => {
  const current = config();
  return {
    ignore: {
      code: [...current.ignoreNames, ...current.ignorePatterns.map(String)].sort(),
      panel: [...panel].sort(),
    },
    keyHeaders: [...current.keyHeaders],
    dedupeWindowMs: current.dedupeWindowMs,
    burst: { windowMs: current.burstWindowMs, count: current.burstCount },
    maxRecords: current.maxRecords,
    reportPath: current.reportPath,
  };
};
