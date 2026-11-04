import { renderGroupKey } from './render/groups.js';
import { busyInstances } from './render/monitor.js';
import { RENDER_STORM } from './render/types.js';
import { isWastefulStat } from './requests/endpointStats.js';

/**
 * RDX 버튼 배지와 보고서 summary 가 같이 쓰는 "문제" 기준. 두 곳이 다른 말을 하지 않게 여기 한 곳에 둔다(#70).
 * - 낭비 요청(duplicates·sameResponses)이 있는 엔드포인트(무시한 엔드포인트는 빼고)
 * - 렌더 폭주 중인 컴포넌트 그룹: 최근 10초에 RENDER_STORM 번 이상 렌더된 인스턴스가 있는 그룹(보고서·렌더 탭과 같은 이름 + 그리는 위치 키)
 */

/** 낭비를 셀 수 있는 엔드포인트 행(패널의 EndpointStat 과 보고서의 requests.endpoints 행 모두) */
export interface WasteRow {
  endpoint: string;
  duplicates: number;
  sameResponses: number;
  ignored?: boolean;
}

/** 렌더 폭주 중인 컴포넌트 그룹 하나 */
export interface RenderStorm {
  name: string;
  location?: string;
  /** 라이브러리 컴포넌트면 패키지와 그린 앱 컴포넌트(보고서에서는 그 앱 컴포넌트 행의 libraries 에 접힌다) */
  package?: string;
  owner?: { name: string; location?: string };
  /** 그룹에서 가장 많이 렌더된 인스턴스의 최근 10초 렌더 수 */
  recent: number;
}

/** 지금 렌더 폭주 중인 컴포넌트 그룹(키: 렌더 그룹 키). 요약하지 않고 렌더 시각만 센다. */
export const findRenderStorms = (now = Date.now()): Map<string, RenderStorm> =>
  busyInstances(RENDER_STORM, now).reduce((acc, { entry, recent }) => {
    const key = renderGroupKey(entry);
    const prev = acc.get(key);
    if (prev) prev.recent = Math.max(prev.recent, recent);
    else
      acc.set(key, {
        name: entry.name,
        ...(entry.location !== undefined && { location: entry.location }),
        ...(entry.package !== undefined && { package: entry.package, owner: entry.owner }),
        recent,
      });
    return acc;
  }, new Map<string, RenderStorm>());

export interface Problems<T extends WasteRow> {
  /** 배지에 다는 문제 수: 낭비 엔드포인트 수 + 렌더 폭주 그룹 수 */
  issues: number;
  wasteEndpoints: T[];
  storms: ReadonlyMap<string, RenderStorm>;
}

/** 배지와 보고서 summary 가 같은 입력(엔드포인트 행, 폭주)으로 문제를 센다. */
export const countProblems = <T extends WasteRow>(endpoints: readonly T[], storms: ReadonlyMap<string, RenderStorm>): Problems<T> => {
  const wasteEndpoints = endpoints.filter((e) => !e.ignored && isWastefulStat(e));
  return { issues: wasteEndpoints.length + storms.size, wasteEndpoints, storms };
};

/** 배지 내역의 렌더 폭주 한 줄. 배지가 그룹마다 세므로 내역도 그룹마다 한 줄이다. */
export interface StormItem {
  name: string;
  /** 같은 이름의 폭주 그룹이 여럿일 때만 그 그룹의 위치(그리는 위치, 라이브러리면 그린 앱 컴포넌트의 위치) */
  location?: string;
  /** 렌더 탭에서 찾을 행의 렌더 그룹 키 */
  key: string;
  /** key 로 못 찾을 때 찾을 키: 라이브러리 그룹이 그린 앱 컴포넌트 행에 접혔으면 그 행 */
  fallbacks?: string[];
}

/** 폭주 그룹을 내역 줄로 바꾼다(이름 → 위치 순). */
export const stormItems = (storms: ReadonlyMap<string, RenderStorm>): StormItem[] => {
  const list = [...storms];
  const names = list.reduce((acc, [, s]) => acc.set(s.name, (acc.get(s.name) ?? 0) + 1), new Map<string, number>());
  return list
    .map(([key, s]): StormItem => {
      const item: StormItem = { name: s.name, key };
      const location = s.location ?? s.owner?.location;
      if (names.get(s.name)! > 1 && location !== undefined) item.location = location;
      if (s.owner) item.fallbacks = [renderGroupKey({ name: s.owner.name, location: s.owner.location })];
      return item;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.location ?? '').localeCompare(b.location ?? ''));
};
