import { describe, expect, it } from 'vitest';

import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { isRenderMonitoring } from '../../render/monitor.js';
import { createRecord, finishRecord } from '../../requests/store.js';
import { buildReport } from '../buildReport.js';
import { installReportApi } from '../reportApi.js';

describe('보고서', () => {
  it('엔드포인트별 낭비 수, 보낸 코드 위치, 낭비 URL 예를 담고 응답 본문은 넣지 않는다', async () => {
    // 같은 코드 위치에서 두 번 보낸다.
    const load = () => fetch('/api/dup?id=1').then((r) => r.json());
    await [0, 1].reduce((prev) => prev.then(load), Promise.resolve());
    await flush();
    const report = buildReport(false);
    const endpoint = report.requests.endpoints[0];
    expect(endpoint).toMatchObject({ endpoint: 'GET /api/dup', count: 2, duplicates: 1, wasteExamples: ['/api/dup?id=1'] });
    expect(endpoint.callers[0]).toMatchObject({ count: 2, frame: expect.stringContaining('report.test.ts') });
    expect(JSON.stringify(report)).not.toContain('CPU 경고');
    expect(report.renders.monitoring).toBe(false);
  });

  it('패널에서 의도된 반복으로 지정한 엔드포인트는 보고서에서도 낭비로 세지 않는다', async () => {
    localStorage.setItem('react-data-xray:ignored-endpoints', JSON.stringify(['GET /api/status']));
    const load = () => fetch('/api/status').then((r) => r.json());
    await [0, 1].reduce((prev) => prev.then(load), Promise.resolve());
    await flush();
    const endpoint = buildReport(false).requests.endpoints.find((e) => e.endpoint === 'GET /api/status');
    expect(endpoint).toMatchObject({ ignored: true, duplicates: 0, wasteExamples: [] });
  });

  it('Firefox·Safari 형식의 호출 스택도 보낸 위치로 읽는다', () => {
    const record = createRecord('fetch', 'GET', '/api/ff');
    record.stack = 'loadUsers@http://localhost:5173/src/api.ts:12:3\nApp@http://localhost:5173/src/App.tsx:5:1';
    finishRecord(record, 200);
    const endpoint = buildReport(false).requests.endpoints.find((e) => e.endpoint === 'GET /api/ff');
    expect(endpoint?.callers[0].frame).toBe('loadUsers@http://localhost:5173/src/api.ts:12:3 <- App@http://localhost:5173/src/App.tsx:5:1');
  });

  it('dev 서버 미들웨어가 있다고 답할 때만 보고서를 보내고 렌더 감시를 켠다', async () => {
    // 1) 프록시·SPA 폴백처럼 200 을 주지만 표시 헤더가 없으면 아무것도 보내지 않는다.
    mockFetch.mockImplementation(async () => new Response('<html></html>', { status: 200 }));
    installReportApi();
    await flush();
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(isRenderMonitoring()).toBe(false);
  });
});
