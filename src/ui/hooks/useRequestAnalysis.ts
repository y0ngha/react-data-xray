import { useMemo } from 'react';

import { classifyRecords, type RequestClass } from '../../core/requests/classify.js';
import { getEndpointStats, isWastefulStat, type EndpointStat } from '../../core/requests/endpointStats.js';
import { requestKeyOf } from '../../core/requests/requestKey.js';
import { getRecordsSnapshot } from '../../core/requests/store.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { useRecordsVersion } from './useRecordsVersion.js';

export interface RequestAnalysis {
  records: readonly RequestRecord[];
  classes: ReadonlyMap<number, RequestClass>;
  classOf: (record: RequestRecord) => RequestClass;
  stats: EndpointStat[];
  statsByEndpoint: ReadonlyMap<string, EndpointStat>;
  /** 낭비 요청이 있는 엔드포인트 수 */
  wasteCount: number;
}

/** 요청 기록을 분류하고 엔드포인트별로 모은다. 기록이 바뀌거나 무시 목록이 바뀔 때만 다시 계산한다. */
export const useRequestAnalysis = (ignored: ReadonlySet<string>): RequestAnalysis => {
  // 기록이 바뀌면 다시 렌더되고, 그때 받은 복사본이 새 배열이라 다시 계산한다.
  useRecordsVersion();
  const records = getRecordsSnapshot();
  return useMemo(() => {
    const classes = classifyRecords(records, ignored);
    const stats = getEndpointStats(records, classes);
    return {
      records,
      classes,
      classOf: (record: RequestRecord) => classes.get(record.id) ?? 'ok',
      stats,
      statsByEndpoint: new Map(stats.map((s) => [s.endpoint, s])),
      wasteCount: stats.filter(isWastefulStat).length,
    };
  }, [records, ignored]);
};

/**
 * 분석 대상(고른 컴포넌트 안)이 쓰는 요청만 남긴다. 쓰는 요청과 같은 요청(메서드·URL·본문, requestKeyOf)이면
 * 이전 기록도 남긴다(폴링으로 몇 번 받았는지 보려고). 분류는 전체 기록 기준 그대로 둔다(중복·주기는 전체를 봐야 안다).
 * 요청 탭·타임라인이 같은 모양을 받도록 RequestAnalysis 로 돌려준다.
 */
export const narrowAnalysis = (analysis: RequestAnalysis, usedKeys: ReadonlySet<string>): RequestAnalysis => {
  const records = analysis.records.filter((r) => usedKeys.has(requestKeyOf(r)));
  const stats = getEndpointStats(records, analysis.classes);
  return {
    ...analysis,
    records,
    stats,
    statsByEndpoint: new Map(stats.map((s) => [s.endpoint, s])),
    wasteCount: stats.filter(isWastefulStat).length,
  };
};
