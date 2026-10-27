import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { isRenderMonitoring } from '../../render/monitor.js';
import { buildReport } from '../buildReport.js';
import { installReportApi, REPORT_PATH } from '../reportApi.js';

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

  it('window.__RDX__ 를 걸고, dev 서버 플러그인이 받으면 보고서를 보내고 렌더 감시를 켠다', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === REPORT_PATH ? new Response(null, { status: 204 }) : jsonResponse({ ok: true }),
    );
    installReportApi();
    await flush();
    const upload = mockFetch.mock.calls.find(([input]) => input === REPORT_PATH);
    expect(JSON.parse(String(upload?.[1]?.body))).toHaveProperty('requests.endpoints');
    expect(isRenderMonitoring()).toBe(true);
    expect(window.__RDX__?.report().renders.monitoring).toBe(true);
  });
});
