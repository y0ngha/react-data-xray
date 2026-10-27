import { getNativeFetch } from './nativeFetch.js';

/**
 * 호출 스택의 위치(dev 서버가 변환한 코드 기준)를 원본 소스 위치로 바꾼다.
 * Vite 처럼 모듈 끝에 sourceMappingURL(data URL 또는 파일)을 붙이는 dev 서버에서 동작한다.
 * 라이브러리 프레임(node_modules, Vite 의 사전 번들)은 건너뛴다. 알고 싶은 것은 앱 코드 위치이고, 큰 번들의 소스맵은 비싸다.
 */

interface Segment {
  /** 변환된 코드의 열(0 부터) */
  column: number;
  source: number;
  line: number;
  sourceColumn: number;
}

interface ParsedMap {
  sources: string[];
  /** 변환된 코드의 줄마다 열 순서로 정렬된 구간 */
  lines: Segment[][];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** 소스맵의 Base64 VLQ 한 덩어리(세미콜론·쉼표 사이)를 숫자들로 푼다. */
const decodeVlq = (segment: string): number[] => {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = DIGIT.get(char) ?? 0;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
};

/** mappings 문자열을 줄별 구간으로 푼다. 앞 구간 기준의 차이값을 누적한다. */
export const parseMappings = (mappings: string): Segment[][] => {
  let source = 0;
  let line = 0;
  let sourceColumn = 0;
  return mappings.split(';').map((group) => {
    let column = 0;
    const segments: Segment[] = [];
    group.split(',').forEach((text) => {
      if (!text) return;
      const [dc = 0, ds, dl, dsc] = decodeVlq(text);
      column += dc;
      if (ds === undefined || dl === undefined || dsc === undefined) return;
      source += ds;
      line += dl;
      sourceColumn += dsc;
      segments.push({ column, source, line, sourceColumn });
    });
    return segments;
  });
};

// 이보다 큰 모듈(인라인 소스맵 제외)은 앱과 라이브러리를 한 파일에 묶은 번들(webpack 등)이라 소스맵이 수십 MB 다. 메인 스레드를 멈추지 않게 건너뛴다.
const MAX_MODULE_BYTES = 1_000_000;

const MAP_COMMENT = /\/[/*][#@]\s*sourceMappingURL=([^\s*]+)\s*(?:\*\/\s*)?$/;

/** data URL 의 내용(UTF-8). base64 면 바이트로 풀어 UTF-8 로 읽는다(한글 경로 등). 깨진 값이면 null */
const dataUrlText = (url: string): string | null => {
  const comma = url.indexOf(',');
  const body = url.slice(comma + 1);
  try {
    if (!url.slice(0, comma).endsWith(';base64')) return decodeURIComponent(body);
    return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

/** 소스맵 JSON. 깨진 값이면 null(그 모듈은 원래 위치 그대로 둔다) */
const parseMapJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** 실패 응답(dev 서버 재시작 중의 502 등)은 거부해서, 캐시에 남지 않고 다음에 다시 받게 한다. */
const textOf = (r: Response): Promise<string> => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))));

const loadMap = async (scriptUrl: string): Promise<ParsedMap | null> => {
  const send = getNativeFetch();
  if (!send) return null;
  const code = await send(scriptUrl, { credentials: 'same-origin' }).then(textOf);
  const ref = MAP_COMMENT.exec(code.trimEnd())?.[1];
  if (!ref || code.length - ref.length > MAX_MODULE_BYTES) return null;
  const mapUrl = new URL(ref, scriptUrl).href;
  const json = mapUrl.startsWith('data:')
    ? parseMapJson(dataUrlText(mapUrl))
    : parseMapJson(await send(mapUrl, { credentials: 'same-origin' }).then(textOf));
  const map = json as { sources?: string[]; sourceRoot?: string; mappings?: string } | null;
  if (!map?.mappings || !map.sources) return null;
  const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
  const base = entryBase();
  // sources 는 소스맵(또는 모듈) 위치 기준 상대 경로일 수 있다(Vite: "client.ts"). 모듈 주소 기준으로 풀어 경로를 살린다.
  return { sources: map.sources.map((s) => sourcePath(`${root}${s}`, scriptUrl, base)), lines: parseMappings(map.mappings) };
};

// HMR 이 모듈 주소에 ?t= 를 붙여 새 키가 계속 생기므로, 오래된 것부터 버린다.
const MAX_MAPS = 200;
// 모듈마다 한 번만 받는다. 소스맵이 없는 모듈은 기억하고, 네트워크 실패(dev 서버 재시작 중 등)는 다음에 다시 받는다.
const maps = new Map<string, Promise<ParsedMap | null>>();

const mapOf = (scriptUrl: string): Promise<ParsedMap | null> => {
  const cached = maps.get(scriptUrl);
  if (cached) return cached;
  const loading: Promise<ParsedMap | null> = loadMap(scriptUrl).catch(() => {
    // 그 사이 캐시에서 밀려났다가 다시 받은 항목은 지우지 않는다.
    if (maps.get(scriptUrl) === loading) maps.delete(scriptUrl);
    return null;
  });
  maps.set(scriptUrl, loading);
  if (maps.size > MAX_MAPS) maps.delete(maps.keys().next().value as string);
  return loading;
};

/** dev 서버가 소스를 내주는 경로(Vite 의 base, 예: /assets/). 모듈 주소에서 떼어 프로젝트 기준 경로로 보인다. */
const entryBase = (): string => {
  // Vite 는 base 아래에 @vite/client 를 넣는다. 못 찾으면(인라인 import 하는 SSR 등) 서버 루트를 base 로 본다.
  const client = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
    (el) => new URL(el.src).pathname,
  ).find((p) => p.includes('/@vite/client'));
  return client ? client.slice(0, client.indexOf('@vite/client')) : '/';
};

/**
 * 파일 시스템 절대 경로를 프로젝트 기준으로: 마지막 src/ 와 그 앞 폴더 하나(모노레포에서 패키지를 가리게),
 * src/ 가 없으면 마지막 두 단계만(홈 폴더 경로를 보고서에 남기지 않게).
 */
const projectPath = (absolute: string): string => {
  const path = absolute.replace(/^\/?\.\//, '');
  if (path.startsWith('src/')) return path;
  const at = path.lastIndexOf('/src/');
  if (at >= 0) return path.slice(path.lastIndexOf('/', at - 1) + 1);
  return path.split('/').slice(-2).join('/');
};

/**
 * 소스맵의 source 를 사람이 찾을 수 있는 경로로.
 * 파일 시스템 절대 경로(/Users/…, webpack:///…)는 프로젝트 기준으로 줄이고, 모듈 주소 기준 상대 경로는 base 를 뗀 서버 경로 그대로.
 */
const sourcePath = (source: string, scriptUrl: string, base: string): string => {
  if (/^(\/|[a-z]+:)/i.test(source) && !source.startsWith('http')) return projectPath(source.replace(/^[a-z]+:\/\/\/?/i, '/'));
  const path = new URL(source, scriptUrl).pathname;
  return path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '');
};

/** 변환된 코드의 (줄, 열)(1 부터)에 해당하는 원본 위치 */
export const originalPosition = (map: ParsedMap, line: number, column: number): string | null => {
  const segments = map.lines[line - 1];
  if (!segments?.length) return null;
  // 열 순서로 정렬돼 있으므로 뒤에서부터 처음 만나는, 그 열 이하에서 시작하는 구간
  let i = segments.length - 1;
  while (i > 0 && segments[i].column > column - 1) i--;
  const segment = segments[i];
  const source = map.sources[segment.source];
  return source ? `${source}:${segment.line + 1}:${segment.sourceColumn + 1}` : null;
};

// V8: "at fn (url:1:2)" 또는 "at url:1:2", Firefox·Safari: "fn@url:1:2"
// 브라우저 스택의 http(s) 주소만 본다(테스트 환경의 파일 경로 등은 건너뛴다).
const FRAME = /^(.*?)(\(?)(https?:\/\/[^\s()]+):(\d+):(\d+)(\)?)$/;
const SKIP = /\/node_modules\/|\/\.vite\/deps\//;

const isSameOrigin = (url: string): boolean => {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
};

/** 스택의 각 줄을 원본 위치로 바꾼다. 못 바꾸는 줄(라이브러리, 다른 출처, 소스맵 없음)은 그대로 둔다. */
export const resolveStack = async (stack: string): Promise<string> => {
  const lines = await Promise.all(
    stack.split('\n').map(async (line) => {
      const m = FRAME.exec(line.trim());
      if (!m) return line;
      const [, before, open, url, lineNo, column, close] = m;
      if (SKIP.test(url) || !isSameOrigin(url)) return line;
      const map = await mapOf(new URL(url, location.href).href);
      const original = map && originalPosition(map, Number(lineNo), Number(column));
      return original ? `${before}${open}${original}${close}` : line;
    }),
  );
  return lines.join('\n');
};
