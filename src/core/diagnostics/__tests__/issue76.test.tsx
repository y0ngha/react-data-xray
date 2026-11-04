import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';

import { flush, mockFetch } from '../../../testing/fetchMock.js';
import { SourcesByApi } from '../../../ui/panels/data/SourcesByApi.js';
import { InspectTab } from '../../../ui/panels/inspect/InspectTab.js';
import { resolveStack } from '../../capture/sourceMap.js';
import { buildReport } from '../../report/buildReport.js';
import { setReportPluginState } from '../../report/endpointState.js';
import { installReportApi } from '../../report/reportApi.js';
import { buildDiagnostics, dataEmptyReason } from '../diagnostics.js';

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
    expect(d.capture).toEqual({ installed: true, fetch: true, xhr: true, requestsBeforeInstall: 0 });
    // 텍스트로만 읽은 응답은 출처를 등록하지 않는다.
    expect(d.requests).toEqual({ recorded: 2, jsonResponses: 1, dropped: 0 });
    // 미들웨어 표시 헤더가 없는 dev 서버
    expect(d.reportPlugin).toBe('missing');
    expect(d.sameResponseMemory.retainedChars).toBe(0);
    expect(d.problems).toEqual([]);
    // 보고서에도 같은 값이 들어간다.
    expect(buildReport(false).diagnostics.requests).toEqual(d.requests);
  });

  it('보고서 플러그인이 이 호스트를 막으면 고치는 방법을 문제로 알린다', () => {
    setReportPluginState('forbidden-host');
    expect(buildDiagnostics().reportPlugin).toBe('forbidden-host');
    expect(buildDiagnostics().problems.join(' ')).toMatch(/allowedHosts: \['localhost'\]/);
    setReportPluginState('missing');
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
  });

  it('StrictMode 안에서 그려지는지 알려 준다', () => {
    const App = () => <div>app</div>;
    const { unmount } = render(<App />);
    expect(buildDiagnostics().renderHook.strictMode).toBe(false);
    unmount();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(buildDiagnostics().renderHook.strictMode).toBe(true);
  });
});

describe('빈 상태 문구의 이유', () => {
  it('기록이 없으면, JSON 응답이 없으면 그렇다고 말하고, 있으면 덧붙이지 않는다', async () => {
    expect(dataEmptyReason()).toMatch(/No requests recorded yet.*server/);
    render(<InspectTab result={{ components: [{ depth: 0, name: 'A', hits: [], fiber: null }], guesses: [] }} stats={new Map()} />);
    expect(screen.getByText(/No linked API response found\. No requests recorded yet/)).toBeTruthy();

    await fetch('/api/text-b').then((r) => r.text());
    await flush();
    expect(dataEmptyReason()).toMatch(/None of the 1 recorded response was JSON/);
    render(<SourcesByApi boxes={[]} title="t" />);
    expect(screen.getByText(/receives response data as props\. None of the 1 recorded response was JSON/)).toBeTruthy();

    await fetch('/api/json-b').then((r) => r.json());
    await flush();
    expect(dataEmptyReason()).toBeUndefined();
  });
});
