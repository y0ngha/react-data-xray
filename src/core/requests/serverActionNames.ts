import { getNativeFetch } from '../capture/nativeFetch.js';

/**
 * Next.js Server Action 의 id → 함수 이름.
 *
 * Server Action 은 모두 페이지 주소로 POST 하고 `Next-Action` 헤더에 해시 id 만 실어 보낸다. 요청 스택도
 * router 를 거치며 끊겨 어느 함수인지 알 수 없다. 대신 dev 빌드의 클라이언트 번들은 action 마다
 * `createServerReference("<id>", callServer, void 0, findSourceMapURL, "<함수 이름>")` 을 부르므로,
 * 브라우저가 이미 받은 스크립트에서 이 짝을 읽어 둔다. 못 찾으면 id 로 보여 준다.
 */
const names = new Map<string, string>();
const scannedUrls = new Set<string>();
const listeners = new Set<() => void>();
let scanning = false;

// id 다음 인자들(모듈 참조 등)을 건너뛰고 마지막 문자열 인자(함수 이름)로 닫히는 호출. Turbopack·webpack 출력 모두 이 모양이다.
const SERVER_REFERENCE = /createServerReference[^(]{0,80}\(\s*"([0-9a-f]{16,})"[^;]{0,1000}?,\s*"([A-Za-z_$][\w$]*)"\s*\)/g;

/** 스크립트 본문에서 id → 함수 이름 짝을 찾는다. */
export const parseActionNames = (source: string): Array<[id: string, name: string]> =>
  Array.from(source.matchAll(SERVER_REFERENCE), (m) => [m[1], m[2]] as [string, string]);

/** 알고 있는 함수 이름. 아직 모르면 undefined */
export const actionNameOf = (id: string): string | undefined => names.get(id);

/** 새 이름을 찾았을 때 알린다(엔드포인트 이름이 바뀌므로 화면을 다시 그리게). */
export const onActionNames = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** 이 페이지가 받은 같은 출처 스크립트 주소(처음 받은 것과 나중에 나눠 받은 청크) */
const scriptUrls = (): string[] => {
  const fromTags = Array.from(document.scripts, (s) => s.src);
  const fromResources = performance
    .getEntriesByType('resource')
    .filter((e) => (e as PerformanceResourceTiming).initiatorType === 'script')
    .map((e) => e.name);
  return Array.from(new Set([...fromTags, ...fromResources])).filter((url) => {
    try {
      return url !== '' && new URL(url).origin === location.origin;
    } catch {
      return false;
    }
  });
};

/**
 * 아직 이름을 모르는 action 이 보이면 부른다. 아직 읽지 않은 스크립트만 브라우저 캐시에서 다시 받아 읽는다.
 * 한 번에 하나만 돈다. rdx 자신의 요청이 기록에 섞이지 않게 가로채기 전의 fetch 를 쓴다.
 */
export const learnActionNames = async (): Promise<void> => {
  const fetchOriginal = getNativeFetch();
  if (scanning || !fetchOriginal || typeof document === 'undefined') return;
  scanning = true;
  let found = false;
  try {
    const urls = scriptUrls().filter((u) => !scannedUrls.has(u));
    urls.forEach((u) => scannedUrls.add(u));
    const sources = await Promise.all(
      urls.map((url) =>
        fetchOriginal(url, { cache: 'force-cache' })
          .then((res) => (res.ok ? res.text() : ''))
          .catch(() => ''),
      ),
    );
    sources.flatMap(parseActionNames).forEach(([id, name]) => {
      if (names.get(id) === name) return;
      names.set(id, name);
      found = true;
    });
  } finally {
    scanning = false;
  }
  if (found) listeners.forEach((listener) => listener());
};
