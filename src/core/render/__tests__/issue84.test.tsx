import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BODY, flush } from '../../../testing/fetchMock.js';
import { buildReport } from '../../report/buildReport.js';
import type { RequestRecord } from '../../requests/types.js';
import { flushQueue } from '../../scheduler/idleQueue.js';
import { countEndpointRendersSteps } from '../endpointRenders.js';
import { drain } from '../groups.js';
import { getEndpointRenders, resetRenderStats, setRenderMonitoring } from '../monitor.js';
import type { RenderEntry, RenderEvent } from '../types.js';
import { EndpointRow } from '../../../ui/panels/requests/EndpointRow.js';

beforeEach(() => setRenderMonitoring(true));
afterEach(() => setRenderMonitoring(false));

let reload: () => void = () => undefined;

function Leaf() {
  return <i>leaf</i>;
}
const Row = ({ item }: { item: { title: string } }) => <li>{item.title}</li>;
/** 응답을 state 로 받는 목록. Leaf 는 props 가 그대로라 목록을 따라(부모를 따라) 렌더된다. */
function List() {
  const [items, setItems] = useState<Array<{ id: number; title: string }>>([]);
  useEffect(() => {
    reload = () =>
      void fetch('/api/items')
        .then((r) => r.json())
        .then((json: typeof DEFAULT_BODY) => setItems(json.data.list));
    reload();
  }, []);
  return (
    <div>
      <Leaf />
      <ul>
        {items.map((i) => (
          <Row key={i.id} item={i} />
        ))}
      </ul>
    </div>
  );
}

/** 처음 응답과, 같은 본문을 다시 받은 응답(같은 응답 재요청) */
const loadTwice = async () => {
  render(<List />);
  await act(flush);
  await act(flush);
  await act(async () => reload());
  await act(flush);
  await act(flush);
  flushQueue();
};

describe('엔드포인트별 렌더 비용 (#84)', () => {
  it('endpoint_renders: 응답이 일으킨 렌더를 직접·부모를 따라 모두 세고, 같은 응답으로 일어난 것을 따로 센다', async () => {
    resetRenderStats();
    await loadTwice();
    const r = getEndpointRenders(Date.now(), 60_000).get('GET /api/items')!;
    // 응답마다 List(직접) + Leaf(부모를 따라) + Row 두 개(응답 항목을 props 로 받음)
    expect(r.count).toBe(8);
    expect(r.viaParent.count).toBe(2);
    expect(r.fromSameResponse.count).toBe(4);
    // React dev 빌드는 selfBaseDuration 을 기록한다(값은 상대 비교용)
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.fromSameResponse.ms).toBeLessThanOrEqual(r.ms!);
  });

  it('report_endpoint_renders: 보고서의 requests.endpoints[].renders 와 summary 추정 절감에 같은 응답의 렌더를 싣는다', async () => {
    resetRenderStats();
    await loadTwice();
    const report = buildReport(true);
    const endpoint = report.requests.endpoints.find((e) => e.endpoint === 'GET /api/items')!;
    expect(endpoint.renders).toMatchObject({ count: 8, viaParent: { count: 2 }, fromSameResponse: { count: 4 } });
    const finding = report.summary.topFindings.find((f) => f.target.endpoint === 'GET /api/items')!;
    expect(finding.savings).toMatchObject({ requests: 1, renders: 4 });
    expect(finding.savings?.renderMs).toBe(endpoint.renders!.fromSameResponse.ms);
    expect(finding.evidence.sameResponseRenders).toBe(4);
    expect(report.howToRead?.some((l) => l.startsWith('requests.endpoints[].renders'))).toBe(true);
  });

  it('no_renders_field: 렌더로 이어지지 않은 엔드포인트에는 renders 를 두지 않는다', async () => {
    await act(async () => {
      await fetch('/api/quiet');
    });
    await act(flush);
    const endpoint = buildReport(true).requests.endpoints.find((e) => e.endpoint === 'GET /api/quiet')!;
    expect(endpoint.renders).toBeUndefined();
  });
});

const record = (id: number, url: string, extra: Partial<RequestRecord> = {}): RequestRecord =>
  ({ id, method: 'GET', url, startedAt: 0, durationMs: 1, ...extra }) as RequestRecord;
const entry = (events: RenderEvent[]): RenderEntry => ({ name: 'X', events, fiber: {}, memoized: false });
const ev = (time: number, cause?: RenderEvent['cause'], ms?: number): RenderEvent => ({ time, reason: 'state', cause, ms });

describe('countEndpointRendersSteps (#84)', () => {
  const a = record(1, '/api/a/1');
  const a2 = record(2, '/api/a/2', { sameResponseAs: 1 });
  const b = record(3, '/api/b');

  it('구간 밖 렌더는 빼고, ID 를 묶은 엔드포인트로 합치며, 시간 기록이 없으면 ms 를 두지 않는다', () => {
    const result = drain(
      countEndpointRendersSteps(
        [
          entry([
            ev(5, { record: a, via: 'direct' }, 9),
            ev(10, { record: a, via: 'direct' }, 1),
            ev(20, { record: a2, via: 'parent' }, 2),
          ]),
          entry([ev(20, { record: b, via: 'timing' }), ev(21)]),
          entry([ev(1, { record: b, via: 'direct' })]),
        ],
        10,
      ),
    );
    expect(result.get('GET /api/a/:id')).toEqual({
      count: 2,
      ms: 3,
      viaParent: { count: 1, ms: 2 },
      fromSameResponse: { count: 1, ms: 2 },
    });
    expect(result.get('GET /api/b')).toEqual({ count: 1, viaParent: { count: 0 }, fromSameResponse: { count: 0 } });
  });

  it('keep 으로 거른 컴포넌트는 세지 않고, 기록이 많으면 조각마다 쉰다', () => {
    const many = entry(Array.from({ length: 5000 }, (_, i) => ev(i, { record: b, via: 'direct' }, 0.1)));
    const other = { ...entry([ev(4999, { record: a, via: 'direct' })]), name: 'Other' };
    const steps = countEndpointRendersSteps([many, other], 0, (e) => e.name === 'X');
    let yields = 0;
    let r = steps.next();
    while (!r.done) {
      yields++;
      r = steps.next();
    }
    expect(yields).toBeGreaterThan(1);
    expect(r.value.get('GET /api/b')).toMatchObject({ count: 5000, ms: 500 });
    expect(r.value.has('GET /api/a/:id')).toBe(false);
  });
});

describe('네트워크 탭 엔드포인트 행 (#84)', () => {
  it('응답이 일으킨 렌더와 같은 응답 렌더를 수·시간으로 보이고, 직접·부모를 따라 나눈 수를 title 에 적는다', () => {
    const stat = { endpoint: 'GET /api/a', count: 3, duplicates: 0, sameResponses: 1, review: 0, explained: 0, avgMs: 10 };
    render(
      <EndpointRow
        stat={stat}
        renders={{ count: 8, ms: 4.2, viaParent: { count: 2, ms: 0.5 }, fromSameResponse: { count: 4, ms: 2.1 } }}
        ignored={undefined}
        onSelect={() => undefined}
        onToggleIgnore={() => undefined}
      />,
    );
    expect(screen.getByText('renders 8 · 4.2ms').title).toContain('6 direct, 2 following a parent');
    expect(screen.getByText('same-resp renders 4 · 2.1ms')).toBeTruthy();
  });
});
