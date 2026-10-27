import { useMemo } from 'react';

import { classifyRecords, type RequestClass } from '../../core/requests/classify.js';
import { getEndpointStats, isWastefulStat, type EndpointStat } from '../../core/requests/endpointStats.js';
import { getRecords } from '../../core/requests/store.js';
import type { RequestRecord } from '../../core/requests/types.js';
import { useRecordsVersion } from './useRecordsVersion.js';

export interface RequestAnalysis {
  records: readonly RequestRecord[];
  classOf: (record: RequestRecord) => RequestClass;
  stats: EndpointStat[];
  statsByEndpoint: ReadonlyMap<string, EndpointStat>;
  /** 낭비 요청이 있는 엔드포인트 수 */
  wasteCount: number;
}

/** 요청 기록을 분류하고 엔드포인트별로 모은다. 기록이 바뀌거나 무시 목록이 바뀔 때만 다시 계산한다. */
export const useRequestAnalysis = (ignored: ReadonlySet<string>): RequestAnalysis => {
  const version = useRecordsVersion();
  return useMemo(() => {
    const records = [...getRecords()];
    const classes = classifyRecords(records, ignored);
    const stats = getEndpointStats(records, classes);
    return {
      records,
      classOf: (record: RequestRecord) => classes.get(record.id) ?? 'ok',
      stats,
      statsByEndpoint: new Map(stats.map((s) => [s.endpoint, s])),
      wasteCount: stats.filter(isWastefulStat).length,
    };
    // version 은 getRecords() 의 내용이 바뀌었다는 신호다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ignored]);
};
