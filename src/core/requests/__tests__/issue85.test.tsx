import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { ignoreMatcher } from '../../../shared/ignoredEndpoints.js';
import { EndpointRow } from '../../../ui/panels/requests/EndpointRow.js';
import { configure, effectiveConfig } from '../../config.js';
import { buildReport } from '../../report/buildReport.js';
import { compare, toComparable } from '../../report/compare.js';
import { buildRequestSection } from '../../report/requestSection.js';
import { classifyRecords } from '../classify.js';
import { getEndpointStats } from '../endpointStats.js';
import { noteNPlusOneStage, nPlusOneRuns, resetNPlusOne, type NPlusOneStage } from '../nPlusOne.js';
import { getRecords } from '../store.js';
import type { RequestRecord } from '../types.js';

let id = 0;
const rec = (startedAt: number, url: string, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  id: ++id,
  kind: 'fetch',
  method: 'GET',
  url,
  status: 200,
  startedAt,
  durationMs: 10,
  body: undefined,
  load: 1,
  ...extra,
});

const STAGES: NPlusOneStage[] = ['annotated', 'deduped', 'finished'];

/** 유휴 큐의 세 step(보낸 곳, 중복 판정, 응답)이 끝난 것처럼 하나씩 알린다 */
const finishAll = (list: RequestRecord[]): RequestRecord[] => {
  list.forEach((r) => STAGES.forEach((stage) => noteNPlusOneStage(r, stage)));
  return list;
};

const owners = (from: number, ids: number[], extra: Partial<RequestRecord> = { component: 'ItemCard' }) =>
  ids.map((n, i) => rec(from + i * 20, `/api/items/${n}/owner`, extra));

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

beforeEach(() => resetNPlusOne());

describe('항목마다 보낸 요청(N+1) 판정 (#85)', () => {
  it('1초 안에 같은 컴포넌트가 서로 다른 ID 로 5건 이상 보내면 모두 짚는다', () => {
    const list = finishAll(owners(1_000, range(6)));
    expect(list.every((r) => r.nPlusOne?.component === 'ItemCard')).toBe(true);
    const runs = nPlusOneRuns(list);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ endpoint: 'GET /api/items/:id/owner', component: 'ItemCard', distinct: 6 });
  });

  it('4건이거나 1초 넘게 퍼져 있으면 짚지 않는다', () => {
    expect(finishAll(owners(1_000, range(4))).some((r) => r.nPlusOne)).toBe(false);
    const spread = range(5).map((n) => rec(2_000 + n * 300, `/api/items/${n}/owner`, { component: 'ItemCard' }));
    expect(finishAll(spread).some((r) => r.nPlusOne)).toBe(false);
  });

  it('창을 품은 새 기록이 앞선 기록까지 함께 짚는다(늦게 끝난 요청)', () => {
    const list = owners(1_000, range(5));
    // 마지막에 시작한 요청이 먼저 끝나고, 첫 요청이 가장 늦게 끝난다
    finishAll([list[4], list[3], list[2], list[1]]);
    expect(list.some((r) => r.nPlusOne)).toBe(false);
    finishAll([list[0]]);
    expect(list.every((r) => r.nPlusOne)).toBe(true);
  });

  it('보낸 곳(annotate)이 늦게 채워진 기록도 빠지지 않고, 그 기록의 step 이 판정한다', () => {
    const list = owners(1_000, range(5), {});
    // 넷은 다 준비됐고, 마지막 하나는 응답·중복 판정만 끝나고 보낸 곳을 아직 모른다
    list.forEach((r, i) => {
      r.component = i < 4 ? 'ItemCard' : undefined;
      noteNPlusOneStage(r, 'finished');
      noteNPlusOneStage(r, 'deduped');
      if (i < 4) noteNPlusOneStage(r, 'annotated');
    });
    expect(list.some((r) => r.nPlusOne)).toBe(false);
    list[4].component = 'ItemCard';
    expect(noteNPlusOneStage(list[4], 'annotated')).toBe(true);
    expect(list.every((r) => r.nPlusOne?.component === 'ItemCard')).toBe(true);
  });

  it('중복 판정이 끝나지 않은 기록은 넣지 않는다', () => {
    const list = owners(1_000, range(5));
    list.forEach((r) => {
      noteNPlusOneStage(r, 'annotated');
      noteNPlusOneStage(r, 'finished');
    });
    expect(list.some((r) => r.nPlusOne)).toBe(false);
    list.forEach((r) => noteNPlusOneStage(r, 'deduped'));
    expect(list.every((r) => r.nPlusOne)).toBe(true);
  });

  it('같은 ID 의 반복(중복)은 서로 다른 ID 로 세지도 섞지도 않는다', () => {
    // 같은 ID 만 여섯 번: 중복이지 N+1 이 아니다
    const same = owners(1_000, [7, 7, 7, 7, 7, 7]);
    same.forEach((r, i) => {
      if (i > 0) r.duplicateOf = same[i - 1].id;
    });
    expect(finishAll(same).some((r) => r.nPlusOne)).toBe(false);
    // 서로 다른 ID 4개 + 쿼리만 다른 같은 ID: 서로 다른 ID 는 4개뿐이다
    const queryOnly = [...owners(3_000, range(4)), rec(3_100, '/api/items/4/owner?fields=name', { component: 'ItemCard' })];
    expect(finishAll(queryOnly).some((r) => r.nPlusOne)).toBe(false);
    // N+1 묶음 안에 낀 중복 요청은 표시하지 않는다
    const mixed = owners(5_000, range(5));
    const dup = rec(5_050, '/api/items/2/owner', { component: 'ItemCard', duplicateOf: mixed[1].id });
    finishAll([...mixed, dup]);
    expect(mixed.every((r) => r.nPlusOne)).toBe(true);
    expect(dup.nPlusOne).toBeUndefined();
  });

  it('다른 컴포넌트가 보낸 요청은 섞지 않는다', () => {
    const list = finishAll([...owners(1_000, [1, 2, 3]), ...owners(1_010, [4, 5, 6], { component: 'Header' })]);
    expect(list.some((r) => r.nPlusOne)).toBe(false);
    const flagged = finishAll([...owners(2_000, range(5)), rec(2_050, '/api/items/9/owner', { component: 'Header' })]);
    expect(flagged.filter((r) => r.nPlusOne).map((r) => r.nPlusOne?.component)).toEqual(Array(5).fill('ItemCard'));
  });

  it('컴포넌트를 모르면 같은 호출 위치로 묶고, 위치도 모르면 짚지 않는다', () => {
    const stack = 'at loadOwner (http://localhost/src/api.ts:3:1)\nat http://localhost/src/list.ts:9:2';
    const byLocation = finishAll(owners(1_000, range(5), { stack }));
    const location = 'at loadOwner (http://localhost/src/api.ts:3:1) <- at http://localhost/src/list.ts:9:2';
    expect(byLocation.every((r) => r.nPlusOne?.location === location)).toBe(true);
    // 서로 다른 위치에서 보낸 것은 섞지 않는다
    const other = 'at http://localhost/src/other.ts:1:1';
    const twoPlaces = finishAll([...owners(3_000, [1, 2, 3], { stack }), ...owners(3_005, [4, 5], { stack: other })]);
    expect(twoPlaces.some((r) => r.nPlusOne)).toBe(false);
    // 스택이 끊긴 요청(noAppFrame)과 스택이 없는 요청은 짚지 않는다
    const broken = owners(5_000, range(5), { stack: 'at node_modules/ky/index.js:1:1', noAppFrame: true });
    expect(finishAll(broken).some((r) => r.nPlusOne)).toBe(false);
    expect(finishAll(owners(7_000, range(5), {})).some((r) => r.nPlusOne)).toBe(false);
  });

  it('경로에 ID 조각이 없는 엔드포인트와 다른 페이지(load)의 요청은 짚지 않는다', () => {
    const search = range(5).map((n) => rec(1_000 + n, `/api/search?q=${n}`, { component: 'ItemCard' }));
    expect(finishAll(search).some((r) => r.nPlusOne)).toBe(false);
    const loads = owners(2_000, range(5));
    loads.forEach((r, i) => {
      r.load = i < 3 ? 1 : 2;
    });
    expect(finishAll(loads).some((r) => r.nPlusOne)).toBe(false);
  });

  it('창보다 길게 끊기면 다른 묶음이고, count 는 서로 다른 ID 수다', () => {
    const list = finishAll([
      ...owners(1_000, range(7)),
      rec(1_150, '/api/items/3/owner?fields=name', { component: 'ItemCard' }),
      ...owners(5_000, [8, 9, 10, 11, 12]),
    ]);
    expect(nPlusOneRuns(list).map((run) => run.distinct)).toEqual([7, 5]);
  });

  it('창과 건수는 configure({ nPlusOne }) 로 바꾸고, 보고서 config 와 비교 기준에 남는다', () => {
    const before = toComparable(buildReport(false));
    configure({ nPlusOne: { windowMs: 2000, count: 3 } });
    expect(effectiveConfig().nPlusOne).toEqual({ windowMs: 2000, count: 3 });
    const spread = [1, 2, 3].map((n) => rec(1_000 + n * 600, `/api/items/${n}/owner`, { component: 'ItemCard' }));
    expect(finishAll(spread).every((r) => r.nPlusOne)).toBe(true);
    const after = toComparable(buildReport(false));
    expect(compare(before, after).warnings).toContain(
      'detection config differs: nPlusOne {"windowMs":1000,"count":5} / {"windowMs":2000,"count":3}',
    );
    // 이 기준이 없던 옛 보고서와는 이 항목을 비교하지 않는다
    const old = { ...before, config: { ...before.config!, nPlusOne: undefined } } as unknown as typeof before;
    expect(compare(old, after).warnings.some((w) => w.includes('nPlusOne'))).toBe(false);
  });

  it('맞지 않는 nPlusOne 값은 경고하고 기본값을 쓴다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configure({ nPlusOne: { windowMs: -1, count: 1 } });
    expect(effectiveConfig().nPlusOne).toEqual({ windowMs: 1000, count: 5 });
    configure({ nPlusOne: 3 as unknown as { count: number } });
    expect(effectiveConfig().nPlusOne).toEqual({ windowMs: 1000, count: 5 });
    const messages = warn.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes('nPlusOne.windowMs'))).toBe(true);
    expect(messages.some((m) => m.includes('nPlusOne.count'))).toBe(true);
    expect(messages.some((m) => m.includes('nPlusOne must be an object'))).toBe(true);
    warn.mockRestore();
  });

  it('보고서 requests.nPlusOne 과 엔드포인트 행에 싣는다(노랑: 낭비로 세지 않는다)', () => {
    const list = finishAll([...owners(1_000, range(24)), rec(1_100, '/api/items/1', { component: 'Page' })]);
    const classes = classifyRecords(list, new Set());
    const section = buildRequestSection(list, classes, new Set(), () => undefined);
    expect(section.nPlusOne).toEqual([
      {
        endpoint: 'GET /api/items/:id/owner',
        endpointId: 'ep:GET /api/items/:id/owner',
        component: 'ItemCard',
        componentId: 'c:ItemCard',
        count: 24,
        windowMs: 23 * 20,
        examples: ['/api/items/1/owner', '/api/items/2/owner', '/api/items/3/owner'],
      },
    ]);
    const row = getEndpointStats(list, classes).find((s) => s.endpoint === 'GET /api/items/:id/owner');
    expect(row?.nPlusOne).toEqual([{ component: 'ItemCard', count: 24 }]);
    expect(row?.duplicates).toBe(0);
  });

  it('무시한 엔드포인트(패널·코드)는 보고서에도 패널 행에도 N+1 로 싣지 않는다', () => {
    const list = finishAll(owners(1_000, range(5)));
    const classes = classifyRecords(list, new Set());
    expect(buildRequestSection(list, classes, new Set(['GET /api/items/:id/owner']), () => undefined).nPlusOne).toEqual([]);
    configure({ ignore: [/owner/] });
    expect(buildRequestSection(list, classes, ignoreMatcher(), () => undefined).nPlusOne).toEqual([]);
    const stat = getEndpointStats(list, classes)[0];
    const row = (ignored?: 'code' | 'panel') =>
      render(<EndpointRow stat={stat} ignored={ignored} onSelect={() => undefined} onToggleIgnore={() => undefined} />);
    expect(row().container.textContent).toContain('N+1: <ItemCard>×5');
    expect(row('code').container.textContent).not.toContain('N+1');
  });
});

const ItemCard = ({ itemId }: { itemId: number }) => {
  useEffect(() => {
    void fetch(`/api/items/${itemId}/owner`);
  }, [itemId]);
  return null;
};

describe('N+1 판정은 유휴 큐에서 한다 (#85)', () => {
  it('목록의 카드마다 보낸 요청을 보고서 nPlusOne 과 summary 에 싣는다', async () => {
    render(
      <>
        {range(6).map((n) => (
          <ItemCard key={n} itemId={n} />
        ))}
      </>,
    );
    await flush();
    await flush();
    const records = getRecords();
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.nPlusOne)).toBe(true);
    const report = buildReport(false);
    expect(report.requests.nPlusOne).toHaveLength(1);
    expect(report.requests.nPlusOne[0]).toMatchObject({ endpoint: 'GET /api/items/:id/owner', count: 6 });
    const finding = report.summary.topFindings.find((f) => f.kind === 'n-plus-one');
    expect(finding).toMatchObject({
      severity: 'medium',
      target: { endpoint: 'GET /api/items/:id/owner' },
      evidence: { count: 6 },
      savings: { requests: 5 },
      detail: 'requests.nPlusOne[0]',
    });
    expect(finding?.fix).toMatch(/batch/);
    // 배지(낭비)는 세지 않는다
    expect(report.summary.badge.issues).toBe(0);
  });
});
