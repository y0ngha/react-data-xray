import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockFetch } from '../../../testing/fetchMock.js';
import { whenSourcesResolved } from '../../capture/requestContext.js';
import { auditQueryCache, findQueryClients, shownStacks } from '../../reactQuery/cacheAudit.js';
import { getCommits, resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { appFramesOf } from '../../requests/callerFrames.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { compare } from '../compare.js';
import { componentId, componentIdOf, endpointId } from '../../../shared/ids.js';
import { buildReactQuerySection } from '../reactQuerySection.js';
import { buildRenderSection } from '../renderSection.js';
import { buildSummary } from '../summarySection.js';

const inlineMap = (map: object) => `data:application/json;base64,${btoa(JSON.stringify(map))}`;

let bump: () => void = () => {};
const Leaf = ({ n }: { n: number }) => <i>{n}</i>;
const Middle = ({ n }: { n: number }) => <Leaf n={n} />;
const Counter = () => {
  const [n, setN] = useState(0);
  useEffect(() => {
    bump = () => setN((x) => x + 1);
  }, []);
  return <Middle n={n} />;
};

beforeEach(() => setRenderMonitoring(true));
afterEach(() => {
  cleanup();
  resetRenderStats();
});

describe('보고서의 고칠 위치와 섹션 공통 id (#73)', () => {
  it('causedBy·heaviestCommits.startedBy 에 시작한 컴포넌트의 JSX 위치와 그 행의 id 를 싣는다', () => {
    render(<Counter />);
    act(() => bump());
    act(() => bump());
    flushQueue();
    const sec = buildRenderSection(true, Date.now());
    const counter = sec.components.find((c) => c.name === 'Counter')!;
    const leaf = sec.components.find((c) => c.name === 'Leaf')!;
    expect(counter.id).toBe(componentId('Counter', counter.renderedAt));
    // 조상의 위치와 id 는 그 조상의 행과 같아 id 로 바로 찾아갈 수 있다
    expect(leaf.causedBy).toEqual([
      { id: counter.id, name: 'Counter', ...(counter.renderedAt && { renderedAt: counter.renderedAt }), reason: 'state', count: 2 },
    ]);
    const started = sec.heaviestCommits?.find((c) => c.startedBy?.name === 'Counter')?.startedBy;
    expect(started).toEqual({ id: counter.id, name: 'Counter', ...(counter.renderedAt && { renderedAt: counter.renderedAt }) });
    // 모든 causedBy id 가 렌더 행 하나를 가리킨다(행 상한 밖이면 없을 수 있다고 howToRead 에 적었다)
    const ids = new Set(sec.components.map((c) => c.id));
    sec.components.flatMap((c) => c.causedBy).forEach((o) => expect(ids.has(o.id)).toBe(true));
    // commit 은 렌더 기록(fiber·이벤트)이 아니라 행 칸만 든다
    const commit = getCommits().find((c) => c.startedBy === 'Counter')!;
    expect(Object.keys(commit.startedFrom ?? {}).sort()).toEqual(counter.renderedAt ? ['location', 'name'] : ['name']);
  });

  it('같은 자리의 여러 인스턴스가 시작한 렌더는 causedBy 한 칸에 센다', () => {
    const bumps: Array<() => void> = [];
    const Item = () => {
      const [n, setN] = useState(0);
      useEffect(() => {
        bumps.push(() => setN((x) => x + 1));
      }, []);
      return <Middle n={n} />;
    };
    render(
      <>
        {[1, 2, 3].map((k) => (
          <Item key={k} />
        ))}
      </>,
    );
    act(() => bumps.forEach((b) => b()));
    flushQueue();
    const sec = buildRenderSection(true, Date.now());
    const item = sec.components.find((c) => c.name === 'Item')!;
    expect(sec.components.find((c) => c.name === 'Leaf')!.causedBy).toEqual([
      { id: item.id, name: 'Item', ...(item.renderedAt && { renderedAt: item.renderedAt }), reason: 'state', count: 3 },
    ]);
  });

  it('id 는 이름과 위치로 만든다(숫자가 아니라 실행이 달라도 같다)', () => {
    expect(endpointId('GET /items/:id')).toBe('ep:GET /items/:id');
    expect(componentId('Row', 'src/Row.tsx:12')).toBe('c:Row@src/Row.tsx:12');
    expect(componentId('Row')).toBe('c:Row');
    // 라이브러리 행은 패키지와 그린 앱 컴포넌트로 가른다(렌더 그룹 키와 같다)
    expect(
      componentIdOf({
        name: 'Cell',
        package: 'ag-grid',
        location: 'node_modules/x.js:1',
        owner: { name: 'Grid', location: 'src/Grid.tsx:9' },
      }),
    ).toBe('c:Cell(ag-grid)<Grid@src/Grid.tsx:9');
    expect(componentIdOf({ name: 'Cell', package: 'ag-grid' })).toBe('c:Cell(ag-grid)');
    expect(componentIdOf({ name: 'Row', location: 'src/Row.tsx:12' })).toBe(componentId('Row', 'src/Row.tsx:12'));
  });

  it('summary·compare 도 같은 id 로 가리킨다', () => {
    const endpoint = {
      id: endpointId('GET /a'),
      endpoint: 'GET /a',
      ignored: false,
      count: 3,
      restoredCount: 0,
      avgMs: 10,
      duplicates: 2,
      sameResponses: 0,
      failedDuplicates: 0,
      review: 0,
      callers: [{ frame: 'at load (src/a.ts:1:1)', count: 3, waste: 2, component: 'List' }],
      wasteExamples: [],
    };
    const summary = buildSummary(
      { total: 3, dropped: 0, endpoints: [endpoint], nPlusOne: [], waterfalls: [], bursts: [], burstsOmitted: 0, followUps: [] },
      { found: false, findings: [], fetchCausesOmitted: 0 },
      {
        monitoring: true,
        windowSeconds: 10,
        truncated: false,
        droppedInstances: 0,
        omitted: { components: 0, renders: 0, avoidable: 0 },
        components: [],
      },
      new Map(),
    );
    expect(summary.topFindings[0].target).toEqual({
      id: 'ep:GET /a',
      endpoint: 'GET /a',
      component: 'List',
      componentId: 'c:List',
      location: 'at load (src/a.ts:1:1)',
    });
    const row = (avoidable: number) => ({ name: 'Row', renders: 5, avoidable, renderedAt: 'src/Row.tsx:3' });
    const make = (duplicates: number, avoidable: number) => ({
      requests: { endpoints: [{ endpoint: 'GET /a', count: 3, duplicates, sameResponses: 0 }] },
      renders: { monitoring: true, windowSeconds: 10, components: [row(avoidable)] },
      reactQuery: { findings: [] },
    });
    const diff = compare(make(2, 4), make(0, 1));
    expect(diff.requests[0].id).toBe('ep:GET /a');
    expect(diff.renders[0].id).toBe('c:Row@src/Row.tsx:3');
  });

  it('레이아웃 이동 finding 은 고칠 원인 컴포넌트를 id 로, 밀린 컴포넌트를 componentId 로 가리킨다', () => {
    const empty = { total: 0, dropped: 0, endpoints: [], nPlusOne: [], waterfalls: [], bursts: [], burstsOmitted: 0, followUps: [] };
    const renders = {
      monitoring: true,
      windowSeconds: 10,
      truncated: false,
      droppedInstances: 0,
      omitted: { components: 0, renders: 0, avoidable: 0 },
      components: [],
    };
    const row = {
      value: 0.2,
      secondsAgo: 1,
      component: 'Card',
      renderedAt: 'src/Card.tsx:3',
      componentId: 'c:Card@src/Card.tsx:3',
      cause: {
        endpoint: 'GET /a',
        endpointId: 'ep:GET /a',
        component: 'List',
        componentId: 'c:List@src/List.tsx:5',
        renderedAt: 'src/List.tsx:5',
      },
    };
    const summary = buildSummary(empty, { found: false, findings: [], fetchCausesOmitted: 0 }, renders, new Map(), [row]);
    expect(summary.topFindings[0].target).toEqual({
      id: 'c:List@src/List.tsx:5',
      endpoint: 'GET /a',
      endpointId: 'ep:GET /a',
      component: 'List',
      componentId: 'c:Card@src/Card.tsx:3',
      location: 'src/List.tsx:5',
    });
  });

  it('스택은 앱 프레임 앞쪽 3줄로 자르고, 앱 프레임이 없으면 앞쪽 프레임을 남긴다', () => {
    const stack = [
      'at a (http://localhost:3000/src/a.ts?t=1:1:1)',
      'at q (http://localhost:3000/node_modules/@tanstack/query-core/build/x.js:1:1)',
      'at b (http://localhost:3000/src/b.ts:2:2)',
      'at c (http://localhost:3000/src/c.ts:3:3)',
      'at d (http://localhost:3000/src/d.ts:4:4)',
    ].join('\n');
    expect(appFramesOf(stack)).toBe(
      [
        'at a (http://localhost:3000/src/a.ts:1:1)',
        'at b (http://localhost:3000/src/b.ts:2:2)',
        'at c (http://localhost:3000/src/c.ts:3:3)',
      ].join('\n'),
    );
    expect(appFramesOf('at q (http://localhost:3000/node_modules/x/y.js:1:1)')).toBe(
      'at q (http://localhost:3000/node_modules/x/y.js:1:1)',
    );
    expect(appFramesOf('Error')).toBeUndefined();
  });

  it('React Query finding 의 호출 위치는 앱 프레임 3줄이고, 요청 callers 처럼 소스맵으로 원본 위치가 되며, 변환 전·후의 같은 호출 위치는 한 줄로 묶는다', async () => {
    const code = `a\nb\nsave()\n//# sourceMappingURL=${inlineMap({ version: 3, sources: ['rq-save.ts'], mappings: ';;AASE' })}`;
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (input, init) =>
      String(input).includes('/src/rq-save.ts') ? new Response(code) : original(input, init),
    );
    const client = new QueryClient();
    render(<QueryClientProvider client={client}>app</QueryClientProvider>);
    findQueryClients();
    const prepare = Error.prepareStackTrace;
    Error.prepareStackTrace = () =>
      [
        'Error',
        'at recordInvalidate (http://localhost:3000/node_modules/react-data-xray/dist/x.js:1:1)',
        'at client.invalidateQueries (http://localhost:3000/node_modules/react-data-xray/dist/x.js:2:1)',
        'at save (http://localhost:3000/src/rq-save.ts:3:5)',
        'at onSuccess (http://localhost:3000/node_modules/@tanstack/query-core/build/m.js:9:9)',
        'at submit (http://localhost:3000/src/rq-save.ts:1:1)',
        'at click (http://localhost:3000/src/rq-save.ts:2:1)',
        'at more (http://localhost:3000/src/rq-save.ts:2:9)',
      ].join('\n');
    try {
      await client.invalidateQueries({ queryKey: ['nothing'] });
      flushQueue();
      await whenSourcesResolved();
      // 앞 finding 의 위치가 원본으로 바뀐 뒤에 같은 곳에서 또 부른다
      await client.invalidateQueries({ queryKey: ['nothing-else'] });
      flushQueue();
    } finally {
      Error.prepareStackTrace = prepare;
    }
    const misses = auditQueryCache(() => 'ok', []).filter((f) => f.kind === 'invalidate-miss');
    expect(misses).toHaveLength(1);
    expect(misses[0].count).toBe(2);
    // 묶기 키는 기록한 그대로의 위치다
    expect(misses[0].stack?.split('\n')[0]).toBe('at save (http://localhost:3000/src/rq-save.ts:3:5)');
    const lines = shownStacks(misses[0]).stack?.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('at save (src/rq-save.ts:10:3)');
    expect(shownStacks(misses[0]).stack).not.toContain('node_modules');
    // 보고서에는 원본 위치만 싣는다
    const [finding] = buildReactQuerySection([], new Map()).findings.filter((f) => f.kind === 'invalidate-miss');
    expect(finding.stack?.split('\n')[0]).toBe('at save (src/rq-save.ts:10:3)');
    expect(finding).not.toHaveProperty('resolvedStack');
  });
});
