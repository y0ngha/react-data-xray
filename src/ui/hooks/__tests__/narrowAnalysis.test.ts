import { expect, it } from 'vitest';

import { classifyRecords } from '../../../core/requests/classify.js';
import { getEndpointStats } from '../../../core/requests/endpointStats.js';
import { createRecord, finishRecord, getRecords } from '../../../core/requests/store.js';
import { narrowAnalysis, type RequestAnalysis } from '../useRequestAnalysis.js';

it('분석 대상이 쓰는 요청과 같은 요청(메서드·URL·본문)의 이전 기록은 남기고, 다른 요청은 뺀다', () => {
  const send = (url: string) => {
    const r = createRecord('fetch', 'GET', url);
    finishRecord(r, 200);
    return r;
  };
  send('/api/card?pcode=1');
  const latest = send('/api/card?pcode=1');
  send('/api/card?pcode=2');
  send('/api/other');
  const records = getRecords();
  const classes = classifyRecords(records, new Set());
  const stats = getEndpointStats(records, classes);
  const all: RequestAnalysis = {
    records,
    classes,
    classOf: (r) => classes.get(r.id) ?? 'ok',
    stats,
    statsByEndpoint: new Map(stats.map((s) => [s.endpoint, s])),
    wasteCount: 0,
  };
  const narrowed = narrowAnalysis(all, new Set([latest]));
  expect(narrowed.records.map((r) => r.url)).toEqual(['/api/card?pcode=1', '/api/card?pcode=1']);
  expect(narrowed.stats).toHaveLength(1);
});
