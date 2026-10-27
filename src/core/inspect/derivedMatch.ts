import { MAX_NODES_PER_BODY } from '../../shared/limits.js';
import { getBodyVersion, getRecords } from '../requests/store.js';
import type { Origin } from '../requests/types.js';

// 이만큼의 필드 값이 같아야 같은 데이터를 가공한 객체로 본다.
const MIN_DERIVED_FIELDS = 2;
// 폴링 화면에서는 응답이 계속 들어오므로, 색인을 다시 만드는 것은 2초에 한 번으로 줄인다.
const INDEX_MIN_AGE_MS = 2000;

/** 우연히 같기 어려운 값만 쓴다(짧은 문자열, 작은 숫자, boolean 은 뺀다). */
const isDistinctive = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.length >= 2 && v.length <= 200) || (typeof v === 'number' && Math.abs(v) >= 10);

const fieldKey = (name: string, value: string | number) => `${name}\u0000${value}`;

/** "필드명=값" → 그 필드를 가진 응답 객체들 */
const buildFieldIndex = (): Map<string, Origin[]> => {
  const index = new Map<string, Origin[]>();
  getRecords().forEach((record) => {
    let nodes = 0;
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object' || nodes++ > MAX_NODES_PER_BODY) return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      const origin: Origin = { record, path };
      Object.entries(value).forEach(([k, v]) => {
        if (!isDistinctive(v)) return walk(v, `${path}.${k}`);
        const key = fieldKey(k, v);
        const list = index.get(key);
        // 같은 값이 수천 번 나오므로 목록을 복사하지 않고 붙인다.
        if (list) list.push(origin);
        else index.set(key, [origin]);
      });
    };
    walk(record.body, '$');
  });
  return index;
};

const cache = { index: null as Map<string, Origin[]> | null, version: -1, builtAt: 0 };

const getFieldIndex = (): Map<string, Origin[]> => {
  const version = getBodyVersion();
  const fresh = cache.index && (version === cache.version || Date.now() - cache.builtAt < INDEX_MIN_AGE_MS);
  if (fresh && cache.index) return cache.index;
  Object.assign(cache, { index: buildFieldIndex(), version, builtAt: Date.now() });
  return cache.index!;
};

/** 객체의 필드 값과 가장 많이 겹치는(2개 이상) 응답 객체. 같은 점수면 최신 응답을 고른다. */
export const findDerivedOrigin = (value: object): Origin | null => {
  const index = getFieldIndex();
  const scores = Object.entries(value)
    .filter((entry): entry is [string, string | number] => isDistinctive(entry[1]))
    .flatMap(([k, v]) => index.get(fieldKey(k, v)) ?? [])
    .reduce((acc, origin) => acc.set(origin, (acc.get(origin) ?? 0) + 1), new Map<Origin, number>());
  // 색인은 오래된 응답 순이므로, 같은 점수면 뒤의 것(최신)이 이기도록 >= 로 고른다.
  const best = Array.from(scores).reduce<[Origin | null, number]>(
    (acc, [origin, score]) => (score >= MIN_DERIVED_FIELDS && score >= acc[1] ? [origin, score] : acc),
    [null, 0],
  );
  return best[0];
};
