import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';

import { flush } from '../../../testing/fetchMock.js';
import { buildReport } from '../../report/buildReport.js';
import { buildRequestSection } from '../../report/requestSection.js';
import { classifyRecords } from '../classify.js';
import { getEndpointStats } from '../endpointStats.js';
import { markNPlusOne, nPlusOneRuns } from '../nPlusOne.js';
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

/** 요청이 끝날 때마다 유휴 큐가 하는 것처럼 하나씩 넣으며 판정한다 */
const finishAll = (list: RequestRecord[]): RequestRecord[] => {
  const done: RequestRecord[] = [];
  list.forEach((r) => {
    done.push(r);
    markNPlusOne(r, done);
  });
  return done;
};

const owners = (from: number, ids: number[], extra: Partial<RequestRecord> = { component: 'ItemCard' }) =>
  ids.map((n, i) => rec(from + i * 20, `/api/items/${n}/owner`, extra));

describe('항목마다 보낸 요청(N+1) 판정 (#85)', () => {
  it('1초 안에 같은 컴포넌트가 서로 다른 ID 로 5건 이상 보내면 모두 짚는다', () => {
    const list = finishAll(owners(1_000, [1, 2, 3, 4, 5, 6]));
    expect(list.every((r) => r.nPlusOne?.component === 'ItemCard')).toBe(true);
    const runs = nPlusOneRuns(list);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ endpoint: 'GET /api/items/:id/owner', component: 'ItemCard' });
    expect(runs[0].records).toHaveLength(6);
  });

  it('4건이거나 1초 넘게 퍼져 있으면 짚지 않는다', () => {
    expect(finishAll(owners(1_000, [1, 2, 3, 4])).some((r) => r.nPlusOne)).toBe(false);
    const spread = [1, 2, 3, 4, 5].map((n) => rec(2_000 + n * 300, `/api/items/${n}/owner`, { component: 'ItemCard' }));
    expect(finishAll(spread).some((r) => r.nPlusOne)).toBe(false);
  });

  it('같은 ID 의 반복(중복)은 서로 다른 ID 로 세지도 섞지도 않는다', () => {
    // 같은 ID 만 여섯 번: 중복이지 N+1 이 아니다
    const same = owners(1_000, [7, 7, 7, 7, 7, 7]).map((r, i) => Object.assign(r, i > 0 ? { duplicateOf: r.id - 1 } : {}));
    expect(finishAll(same).some((r) => r.nPlusOne)).toBe(false);
    // 서로 다른 ID 4개 + 쿼리만 다른 같은 ID: 서로 다른 ID 는 4개뿐이다
    const queryOnly = [...owners(3_000, [1, 2, 3, 4]), rec(3_100, '/api/items/4/owner?fields=name', { component: 'ItemCard' })];
    expect(finishAll(queryOnly).some((r) => r.nPlusOne)).toBe(false);
    // N+1 묶음 안에 낀 중복 요청은 표시하지 않는다
    const mixed = owners(5_000, [1, 2, 3, 4, 5]);
    const dup = rec(5_050, '/api/items/2/owner', { component: 'ItemCard', duplicateOf: mixed[1].id });
    const done = finishAll([...mixed, dup]);
    expect(done.filter((r) => r.nPlusOne)).toHaveLength(5);
    expect(dup.nPlusOne).toBeUndefined();
  });

  it('다른 컴포넌트가 보낸 요청은 섞지 않는다', () => {
    const list = finishAll([...owners(1_000, [1, 2, 3]), ...owners(1_010, [4, 5, 6], { component: 'Header' })]);
    expect(list.some((r) => r.nPlusOne)).toBe(false);
    const flagged = finishAll([...owners(2_000, [1, 2, 3, 4, 5]), rec(2_050, '/api/items/9/owner', { component: 'Header' })]);
    expect(flagged.filter((r) => r.nPlusOne).map((r) => r.nPlusOne?.component)).toEqual(Array(5).fill('ItemCard'));
  });

  it('컴포넌트를 모르면 같은 호출 위치로 묶고, 위치도 모르면 짚지 않는다', () => {
    const stack = 'at loadOwner (http://localhost/src/api.ts:3:1)\nat http://localhost/src/list.ts:9:2';
    const byLocation = finishAll(owners(1_000, [1, 2, 3, 4, 5], { stack }));
    expect(
      byLocation.every(
        (r) => r.nPlusOne?.location === 'at loadOwner (http://localhost/src/api.ts:3:1) <- at http://localhost/src/list.ts:9:2',
      ),
    ).toBe(true);
    // 서로 다른 위치에서 보낸 것은 섞지 않는다
    const other = 'at http://localhost/src/other.ts:1:1';
    const twoPlaces = finishAll([...owners(3_000, [1, 2, 3], { stack }), ...owners(3_005, [4, 5], { stack: other })]);
    expect(twoPlaces.some((r) => r.nPlusOne)).toBe(false);
    // 스택이 끊긴 요청(noAppFrame)과 스택이 없는 요청은 짚지 않는다
    expect(
      finishAll(owners(5_000, [1, 2, 3, 4, 5], { stack: 'at node_modules/ky/index.js:1:1', noAppFrame: true })).some((r) => r.nPlusOne),
    ).toBe(false);
    expect(finishAll(owners(7_000, [1, 2, 3, 4, 5], {})).some((r) => r.nPlusOne)).toBe(false);
  });

  it('경로에 ID 가 없는 엔드포인트와 다른 페이지(load)의 요청은 짚지 않는다', () => {
    const search = [1, 2, 3, 4, 5].map((n) => rec(1_000 + n, `/api/search?q=${n}`, { component: 'ItemCard' }));
    expect(finishAll(search).some((r) => r.nPlusOne)).toBe(false);
    const loads = owners(2_000, [1, 2, 3, 4, 5]).map((r, i) => Object.assign(r, { load: i < 3 ? 1 : 2 }));
    expect(finishAll(loads).some((r) => r.nPlusOne)).toBe(false);
  });

  it('1초 넘게 끊기면 다른 묶음이다', () => {
    const list = finishAll([...owners(1_000, [1, 2, 3, 4, 5, 6, 7]), ...owners(5_000, [8, 9, 10, 11, 12])]);
    expect(nPlusOneRuns(list).map((run) => run.records.length)).toEqual([7, 5]);
  });

  it('보고서 requests.nPlusOne 과 summary, 엔드포인트 행에 싣는다(노랑: 낭비로 세지 않는다)', () => {
    const list = finishAll([
      ...owners(
        1_000,
        Array.from({ length: 24 }, (_, i) => i + 1),
      ),
      rec(1_100, '/api/items/1', { component: 'Page' }),
    ]);
    const classes = classifyRecords(list, new Set());
    const section = buildRequestSection(list, classes, new Set(), () => undefined);
    expect(section.nPlusOne).toEqual([
      {
        endpoint: 'GET /api/items/:id/owner',
        component: 'ItemCard',
        count: 24,
        windowMs: 23 * 20,
        examples: ['/api/items/1/owner', '/api/items/2/owner', '/api/items/3/owner'],
      },
    ]);
    const row = getEndpointStats(list, classes).find((s) => s.endpoint === 'GET /api/items/:id/owner');
    expect(row?.nPlusOne).toEqual([{ component: 'ItemCard', count: 24 }]);
    expect(row?.duplicates).toBe(0);
    // 무시한 엔드포인트는 싣지 않는다
    expect(buildRequestSection(list, classes, new Set(['GET /api/items/:id/owner']), () => undefined).nPlusOne).toEqual([]);
  });
});

const ItemCard = ({ itemId }: { itemId: number }) => {
  useEffect(() => {
    void fetch(`/api/items/${itemId}/owner`);
  }, [itemId]);
  return null;
};

describe('N+1 판정은 요청이 끝난 뒤 유휴 큐에서 한다 (#85)', () => {
  it('목록의 카드마다 보낸 요청을 보고서 nPlusOne 과 summary 에 싣는다', async () => {
    render(
      <>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <ItemCard key={n} itemId={n} />
        ))}
      </>,
    );
    await flush();
    await flush();
    const records = getRecords();
    expect(records).toHaveLength(6);
    // 앱 경로(fetch)에서는 판정하지 않고, 유휴 큐가 끝난 요청을 보고 정한다
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
