import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { SourcesByApi } from '../../../ui/panels/data/SourcesByApi.js';
import { InspectTab } from '../../../ui/panels/inspect/InspectTab.js';
import { resolveStack } from '../../capture/sourceMap.js';
import { buildReport } from '../../report/buildReport.js';
import { setReportPluginState } from '../../report/endpointState.js';
import { installReportApi } from '../../report/reportApi.js';
import { setRenderMonitoring } from '../../render/monitor.js';
import { mergeRecords, subscribe } from '../../requests/store.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { buildDiagnostics, dataEmptyReason, problemCount } from '../diagnostics.js';

describe('window.__RDX__.doctor()', () => {
  it('렌더 훅·가로채기·기록·보고서 플러그인·소스맵·같은 응답 메모리 상태를 돌려준다', async () => {
    installReportApi();
    await flush();
    await fetch('/api/json-a').then((r) => r.json());
    await fetch('/api/text-a').then((r) => r.text());
    await flush();
    const d = window.__RDX__!.doctor();
    expect(d.renderHook.listening).toBe(true);
    expect(d.renderHook.reactVersion).toMatch(/^1[89]\./);
    // 설치 전 요청 수는 import 순서 판정 때 센다(아직 판정하지 않았다).
    expect(d.capture).toEqual({ installed: true, fetch: true, xhr: true, requestsBeforeInstall: null });
    // 텍스트로만 읽은 응답은 출처를 등록하지 않는다.
    expect(d.requests).toEqual({ recorded: 2, restored: 0, jsonResponses: 1, dropped: 0 });
    // 미들웨어 표시 헤더가 없는 dev 서버
    expect(d.reportPlugin).toBe('missing');
    expect(d.sameResponseMemory.retainedChars).toBe(0);
    expect(d.problems).toEqual([]);
    // 보고서에도 같은 값이 들어간다.
    expect(buildReport(false).diagnostics.requests).toEqual(d.requests);
  });

  it('보고서 플러그인이 이 호스트를 막으면 고치는 방법을 문제로 알리고, 바뀌면 구독자에게 알린다', () => {
    const changed = vi.fn<() => void>();
    const off = subscribe(changed);
    setReportPluginState('forbidden-host');
    expect(buildDiagnostics().reportPlugin).toBe('forbidden-host');
    const text = buildDiagnostics().problems.join(' ');
    expect(text).toMatch(/Vite rdx\(\{ allowedHosts: \['localhost'\] \}\)/);
    expect(text).toMatch(/webpack rdxReportMiddleware\(root, \{ allowedHosts/);
    expect(text).toMatch(/Next\.js createRdxReportRoute\(process\.cwd\(\), \{ allowedHosts/);
    expect(problemCount()).toBe(1);
    setReportPluginState('missing');
    flushQueue(); // 구독자 알림은 큐에서 묶어 보낸다
    // 상태가 바뀌면 구독자(도구 막대의 Status 버튼)가 다시 그린다.
    expect(changed).toHaveBeenCalled();
    off();
  });

  it('소스맵을 받지 못하거나 읽지 못하면 센다', async () => {
    const before = buildDiagnostics().sourceMaps.failures;
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/src/down.ts')) return new Response('', { status: 502 });
      if (url.endsWith('.map')) return new Response('{ broken');
      return new Response('code\n//# sourceMappingURL=broken.ts.map');
    });
    await resolveStack('at a (http://localhost:3000/src/down.ts:1:1)\nat b (http://localhost:3000/src/broken.ts:1:1)');
    expect(buildDiagnostics().sourceMaps.failures).toBe(before + 2);
    // 실패한 모듈은 다음에 다시 받는다. 또 실패해도 모듈마다 한 번만 센다.
    await resolveStack('at a (http://localhost:3000/src/down.ts:1:1)');
    expect(buildDiagnostics().sourceMaps.failures).toBe(before + 2);
  });

  it('mappings 가 빈 올바른 소스맵은 실패가 아니다', async () => {
    const before = buildDiagnostics().sourceMaps.failures;
    mockFetch.mockImplementation(async (input) =>
      String(input).endsWith('.map')
        ? new Response(JSON.stringify({ version: 3, sources: [], mappings: '' }))
        : new Response('code\n//# sourceMappingURL=empty.ts.map'),
    );
    const frame = 'at e (http://localhost:3000/src/empty.ts:1:1)';
    expect(await resolveStack(frame)).toBe(frame);
    expect(buildDiagnostics().sourceMaps.failures).toBe(before);
  });

  it('StrictMode 는 기록한 앱 렌더의 fiber 모드로 보고, 기록이 없으면 모른다(null)', () => {
    const App = () => <div>app</div>;
    render(<App />);
    expect(buildDiagnostics().renderHook.strictMode).toBeNull(); // 렌더 감시가 꺼져 있어 기록이 없다
    setRenderMonitoring(true);
    try {
      const { unmount } = render(<App />);
      flushQueue();
      expect(buildDiagnostics().renderHook.strictMode).toBe(false);
      unmount();
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
      flushQueue();
      expect(buildDiagnostics().renderHook.strictMode).toBe(true);
    } finally {
      setRenderMonitoring(false);
    }
  });
});

describe('빈 상태 문구의 이유', () => {
  it('기록이 없으면, JSON 응답이 없으면 그렇다고 말하고, 있으면 덧붙이지 않는다', async () => {
    expect(dataEmptyReason()).toMatch(/No requests recorded on this page yet.*server/);
    render(<InspectTab result={{ components: [{ depth: 0, name: 'A', hits: [], fiber: null }], guesses: [] }} stats={new Map()} />);
    expect(screen.getByText(/No linked API response found\. No requests recorded on this page yet/)).toBeTruthy();

    await fetch('/api/text-b').then((r) => r.text());
    await flush();
    expect(dataEmptyReason()).toMatch(/None of the 1 response recorded on this page was JSON/);
    render(<SourcesByApi boxes={[]} title="t" />);
    expect(screen.getByText(/receives response data as props\. None of the 1 response recorded on this page was JSON/)).toBeTruthy();

    await fetch('/api/json-b').then((r) => r.json());
    await flush();
    expect(dataEmptyReason()).toBeUndefined();
  });

  it('새로고침 전에서 되살린 기록(원문만 있음)은 JSON 이 아닌 응답으로 세지 않는다', () => {
    mergeRecords([
      {
        id: 9001,
        kind: 'fetch',
        method: 'GET',
        url: '/api/restored',
        status: 200,
        startedAt: 0,
        durationMs: 1,
        body: undefined,
        responseText: '{"a":1}',
        restored: true,
      },
    ]);
    expect(dataEmptyReason()).toMatch(/No requests recorded on this page yet/);
    expect(buildDiagnostics().requests).toMatchObject({ recorded: 1, restored: 1, jsonResponses: 0 });
  });
});
