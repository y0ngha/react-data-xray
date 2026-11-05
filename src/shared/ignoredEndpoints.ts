import { configVersion, isConfigIgnored } from '../core/config.js';
import { maskEndpoint } from '../core/requests/endpointMask.js';
import { readStored } from './storage.js';

/** 사용자가 요청 탭에서 "의도된 반복"으로 지정한 엔드포인트. 패널과 보고서가 같은 목록을 쓴다. */
export const IGNORE_KEY = 'react-data-xray:ignored-endpoints';

// 저장된 키도 지금의 ID 묶기 규칙으로 바꾼다. 묶기 전에 저장한 경로는 어느 엔드포인트와도 안 맞고 화면에서 지울 수도 없다.
export const parseIgnored = (raw: unknown): ReadonlySet<string> | undefined =>
  Array.isArray(raw) ? new Set(raw.filter((v): v is string => typeof v === 'string').map(maskEndpoint)) : undefined;

/** 무시한 곳. code 는 configure({ ignore }) 라 패널에서 풀 수 없다 */
export type IgnoreSource = 'code' | 'panel';

/**
 * 패널에서 고른 무시와 코드(configure)의 무시를 합친 판정. 분류·보고서·요청 탭이 모두 이것 하나로 본다.
 * 엔드포인트마다 한 번만 계산해 둔다(분류는 요청마다 묻는다). 설정이나 패널 목록이 바뀌면 새로 만든다.
 */
export interface IgnoreMatcher {
  /** 패널에서 고른 엔드포인트(풀 수 있는 것) */
  readonly panel: ReadonlySet<string>;
  /** 이 판정을 만든 때의 설정 번호(configVersion). 설정이 바뀌면 판정을 새로 만든다 */
  readonly configVersion: number;
  /** 무시한 곳. 무시하지 않으면 undefined. 둘 다면 code(풀 수 없음)다 */
  sourceOf: (endpoint: string) => IgnoreSource | undefined;
}

export const ignoreMatcher = (panel: ReadonlySet<string> = new Set(), version = configVersion()): IgnoreMatcher => {
  const known = new Map<string, IgnoreSource | undefined>();
  return {
    panel,
    configVersion: version,
    sourceOf: (endpoint) => {
      if (known.has(endpoint)) return known.get(endpoint);
      const source = isConfigIgnored(endpoint) ? 'code' : panel.has(endpoint) ? 'panel' : undefined;
      known.set(endpoint, source);
      return source;
    },
  };
};

/** 패널에서 고른 무시(저장된 것) */
export const readPanelIgnores = (): ReadonlySet<string> => readStored(IGNORE_KEY, parseIgnored, new Set<string>());

/** 저장된 패널 무시와 지금 설정의 무시를 합친 판정 */
export const readIgnoredEndpoints = (): IgnoreMatcher => ignoreMatcher(readPanelIgnores());

/** 패널 목록(Set)만 받은 곳(테스트·옛 호출)도 같은 판정을 쓰게 바꾼다 */
export const toIgnoreMatcher = (ignored: IgnoreMatcher | ReadonlySet<string>): IgnoreMatcher =>
  'sourceOf' in ignored ? ignored : ignoreMatcher(ignored);
