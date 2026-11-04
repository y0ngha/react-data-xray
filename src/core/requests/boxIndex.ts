import { isWaste, type RequestClass } from './classify.js';
import { getEndpointStats, type EndpointStat } from './endpointStats.js';
import { requestKeyOf } from './requestKey.js';
import type { RequestRecord } from './types.js';

/** 화면 박스가 출처 요청으로 찾는 것: 라벨 지표와 빨강 여부 */
export interface BoxIndex {
  /** 같은 요청(메서드·URL·payload)의 기록 전체로 센 지표 */
  statOf: (source: RequestRecord) => EndpointStat | undefined;
  /** 같은 페이지(load)에서 출처 이후(출처 포함)에 나간 같은 요청 중 낭비가 있는지 */
  isWastefulSince: (source: RequestRecord) => boolean;
}

/**
 * 박스 라벨 지표와 색의 색인. 요청 키(URL 파싱)는 기록마다 한 번만 계산해 지표 집계에도 쓰고, 박스마다는 Map 조회만 한다.
 * 색: structural sharing 은 응답이 같으면 첫 객체를 두므로 출처는 늘 첫 요청(ok)이고, 그 뒤 같은 응답 재요청이 낭비로 잡힌다(#64).
 * 그래서 출처 하나가 아니라 출처 이후의 같은 요청을 본다. 새로고침 전 페이지의 기록이나, 응답이 바뀌어 출처가 새 요청이 된 경우
 * 그 앞의 중복은 이 데이터와 무관하므로 보지 않는다. 지표는 그 요청의 기록 전체를 센다.
 */
export const buildBoxIndex = (records: readonly RequestRecord[], classes: ReadonlyMap<number, RequestClass>): BoxIndex => {
  const keyById = new Map<number, string>();
  // `${load}|${요청 키}` → 그 묶음에서 가장 늦게 나간 낭비 요청의 시각
  const latestWaste = new Map<string, number>();
  for (const r of records) {
    const key = requestKeyOf(r);
    keyById.set(r.id, key);
    if (!isWaste(classes.get(r.id))) continue;
    const group = `${r.load ?? 0}|${key}`;
    latestWaste.set(group, Math.max(latestWaste.get(group) ?? -Infinity, r.startedAt));
  }
  const keyOf = (r: RequestRecord): string => keyById.get(r.id) ?? requestKeyOf(r);
  const stats = new Map(getEndpointStats(records, classes, keyOf).map((s) => [s.endpoint, s]));
  return {
    statOf: (source) => stats.get(keyOf(source)),
    isWastefulSince: (source) => (latestWaste.get(`${source.load ?? 0}|${keyOf(source)}`) ?? -Infinity) >= source.startedAt,
  };
};
