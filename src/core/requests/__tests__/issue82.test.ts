import { describe, expect, it } from 'vitest';

import { layoutTimeline } from '../../../ui/panels/timeline/timelineLayout.js';
import { findBursts, screenEntryTest } from '../bursts.js';
import type { RequestRecord } from '../types.js';

// #82: 페이지 로드 3초 뒤 SPA 라우트를 옮기면 새 화면의 진입 몰림이 낭비로 잡혔다.
// 라우트가 바뀐 지점은 기록의 route(보낸 시점의 pathname)로 정한다.
// 페이지 첫 로딩(timeOrigin 뒤 3초)과 겹치지 않게 1분 뒤에서 시작한다.
const T = performance.timeOrigin + 60_000;
let nextId = 1;

const req = (startedAt: number, route: string | undefined, load = 1): RequestRecord =>
  ({
    id: nextId++,
    kind: 'fetch',
    method: 'GET',
    url: `/api/${nextId}`,
    status: 200,
    startedAt,
    durationMs: 10,
    body: null,
    route,
    load,
  }) as RequestRecord;

/** at 부터 100ms 간격으로 5건(몰림) */
const burstAt = (at: number, route: string, load = 1): RequestRecord[] => [0, 100, 200, 300, 400].map((d) => req(at + d, route, load));

const entryOfBursts = (records: RequestRecord[]): boolean[] => {
  const isEntry = screenEntryTest(records);
  return findBursts(records.map((r) => r.startedAt)).map((b) => isEntry(b.from));
};

describe('라우트 이동 직후 몰림은 화면 진입이다 (#82)', () => {
  it('pushState 뒤 새 route 로 나간 몰림은 화면 진입이다', () => {
    const records = [req(T, '/home'), ...burstAt(T + 5000, '/orders')];
    expect(entryOfBursts(records)).toEqual([true]);
  });

  it('주소를 바꾸기 전에 데이터를 받는 라우터(loader, RSC)의 몰림도 1초 앞까지는 화면 진입이다', () => {
    // loader 요청 5건은 앞 화면 route 로 나가고, 주소가 바뀐 뒤 첫 요청이 400ms 뒤에 나간다.
    const loader = burstAt(T + 5000, '/home');
    const records = [req(T, '/home'), ...loader, req(T + 5800, '/orders')];
    expect(entryOfBursts(records)).toEqual([true]);
    // 지점보다 1초 넘게 앞선 몰림은 낭비로 남는다.
    const early = [req(T, '/home'), ...burstAt(T + 5000, '/home'), req(T + 6500, '/orders')];
    expect(entryOfBursts(early)).toEqual([false]);
  });

  it('지점에 걸친 몰림은 몰림 단위로 판정해 통째로 화면 진입이다', () => {
    const records = [req(T, '/home'), req(T + 5000, '/home'), req(T + 5100, '/home'), ...burstAt(T + 5200, '/orders')];
    const bursts = findBursts(records.map((r) => r.startedAt));
    expect(bursts).toHaveLength(1);
    expect(screenEntryTest(records)(bursts[0].from)).toBe(true);
    // 타임라인도 같은 판정을 쓴다.
    expect(layoutTimeline(records, [], T + 6000, 400).bursts.map((b) => b.initial)).toEqual([true]);
  });

  it('쿼리·해시만 바뀐 이동은 route(pathname)가 같아 화면 진입이 아니다', () => {
    // route 는 pathname 이라 ?filter= 가 바뀌어도 같다.
    const records = [req(T, '/orders'), ...burstAt(T + 5000, '/orders')];
    expect(entryOfBursts(records)).toEqual([false]);
  });

  it('이동 없이 생긴 몰림, 지점 3초 뒤의 몰림은 지금처럼 낭비다', () => {
    const records = [req(T, '/home'), ...burstAt(T + 5000, '/home')];
    expect(entryOfBursts(records)).toEqual([false]);
    const late = [req(T, '/home'), req(T + 1000, '/orders'), ...burstAt(T + 4000, '/orders')];
    expect(entryOfBursts(late)).toEqual([false]);
  });

  it('새로고침 전 페이지(load 가 다름)의 route 나 route 없는 기록은 지점을 만들지 않는다', () => {
    const records = [req(T, '/home', 1), req(T + 4000, undefined, 2), ...burstAt(T + 5000, '/orders', 2)];
    expect(entryOfBursts(records)).toEqual([false]);
  });

  it('기록이 늘면 지점을 다시 계산하고, 그대로면 이전 계산을 쓴다', () => {
    const records = [req(T, '/home'), ...burstAt(T + 5000, '/home')];
    expect(screenEntryTest(records)(T + 5000)).toBe(false);
    expect(screenEntryTest(records)(T + 5000)).toBe(false);
    records.push(req(T + 5600, '/orders'));
    expect(screenEntryTest(records)(T + 5000)).toBe(true);
  });
});
