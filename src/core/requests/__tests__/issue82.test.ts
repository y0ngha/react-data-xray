import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { layoutTimeline } from '../../../ui/panels/timeline/timelineLayout.js';
import { analyzeBursts } from '../bursts.js';
import type { RequestRecord } from '../types.js';

// #82: 페이지 로드 3초 뒤 SPA 화면을 옮기면 새 화면의 진입 몰림이 낭비로 잡혔다.
// setup.ts 가 설치한 가로채기(`installCapture`)로 history 가 이미 감싸져 있다.
const ok = () => 'ok' as const;
let nextId = 1;

const req = (startedAt: number, extra: Partial<RequestRecord> = {}): RequestRecord =>
  ({
    id: nextId++,
    kind: 'fetch',
    method: 'GET',
    url: `/api/${nextId}`,
    status: 200,
    startedAt,
    durationMs: 10,
    body: null,
    load: 1,
    ...extra,
  }) as RequestRecord;

/** at 부터 100ms 간격으로 5건(몰림) */
const burstAt = (at: number, extra?: Partial<RequestRecord>): RequestRecord[] => [0, 100, 200, 300, 400].map((d) => req(at + d, extra));

/** from 부터 to 까지 100ms 마다 나가는 끝나지 않는 반복 */
const loop = (from: number, to: number): RequestRecord[] => Array.from({ length: (to - from) / 100 }, (_, i) => req(from + i * 100));

const entries = (records: RequestRecord[]): boolean[] => analyzeBursts(records, ok).map((b) => b.entry);

// 테스트마다 앞 테스트의 이동 기록과 겹치지 않게, 페이지 로드 뒤 충분히 떨어진 시각에서 시작한다.
let base = performance.timeOrigin + 60_000;
let T = 0;

/** 시계를 at 으로 옮긴 뒤 fn 을 부른다(이동 시각은 Date.now 로 남는다). */
const at = (time: number, fn: () => void) => {
  vi.setSystemTime(time);
  fn();
};

beforeEach(() => {
  base += 100_000;
  T = base;
  vi.useFakeTimers({ toFake: ['Date'], now: T - 10_000 });
  History.prototype.replaceState.call(history, null, '', '/home');
  window.dispatchEvent(new PopStateEvent('popstate')); // 지금 화면을 /home 으로 맞춘다(이동 기록은 T 보다 10초 앞).
});

afterEach(() => {
  vi.useRealTimers();
  History.prototype.replaceState.call(history, null, '', '/');
});

describe('화면 이동 직후 몰림은 화면 진입이다 (#82)', () => {
  it('pushState 뒤 3초 안에 시작한 몰림은 진입이고, 3초 뒤는 낭비다', () => {
    at(T, () => history.pushState(null, '', '/orders'));
    expect(entries([...burstAt(T + 500), ...burstAt(T + 3000)])).toEqual([true, false]);
  });

  it('응답을 받은 뒤 주소를 바꾸는 라우터(loader, RSC)의 몰림은 응답 끝 1초 뒤까지 이동하면 진입이다', () => {
    at(T + 800, () => history.pushState(null, '', '/orders'));
    expect(entries(burstAt(T))).toEqual([true]);
    // 백엔드가 느려 응답이 1.4초 걸려도, 응답 뒤에 옮기면 진입이다.
    at(T + 20_000 + 1450, () => history.pushState(null, '', '/users'));
    expect(entries(burstAt(T + 20_000 - 400, { durationMs: 1400 }))).toEqual([true]);
    // 마지막 응답보다 1초 넘게 뒤에 옮긴 화면의 진입은 아니다.
    at(T + 40_000 + 1500, () => history.pushState(null, '', '/items'));
    expect(entries(burstAt(T + 40_000))).toEqual([false]);
  });

  it('이동에 걸친 몰림은 반만 빠지지 않고 한 진입 구간이며, 타임라인도 같다', () => {
    at(T + 150, () => history.pushState(null, '', '/orders'));
    const records = [req(T), req(T + 100), ...burstAt(T + 200)];
    const [segment, ...rest] = analyzeBursts(records, ok);
    expect(rest).toEqual([]);
    expect(segment).toMatchObject({ from: T, to: T + 600, entry: true });
    expect(segment.records).toHaveLength(7);
    expect(layoutTimeline(records, [], T + 1000, 400, ok).bursts).toEqual([expect.objectContaining({ count: 7, initial: true })]);
  });

  it('이동 직후 시작해 끝나지 않는 반복은 진입 창을 지나면 낭비 구간이 된다', () => {
    at(T, () => history.pushState(null, '', '/orders'));
    const segments = analyzeBursts(loop(T, T + 8000), ok);
    expect(segments.map((s) => s.entry)).toEqual([true, false]);
    // 진입 창은 이동 3초 뒤에 시작한 창까지다.
    expect(segments[1].windows[0].from).toBeGreaterThan(T + 2400);
    expect(segments[1].windows.every((w) => w.from > T + 2400 && !w.entry)).toBe(true);
    // 한 요청은 한 구간에만 든다.
    expect(segments[0].records.length + segments[1].records.length).toBe(80);
    expect(segments[1].runTo).toBe(T + 7900);
  });

  it('페이지(load)마다 따로 찾고, 새로고침 전 기록은 몰림에 세지 않는다', () => {
    const prev = [req(T, { load: 0 }), req(T + 100, { load: 0 })];
    const restored = [req(T + 150, { restored: true }), req(T + 160, { restored: true })];
    expect(analyzeBursts([...prev, ...restored, req(T + 200), req(T + 300), req(T + 400)], ok)).toEqual([]);
  });

  it('타임라인은 창 밖으로 시작한 구간을 창 안으로 자르고 보이는 요청만 센다', () => {
    const records = loop(T, T + 1000);
    const layout = layoutTimeline(records, [], T + 20_500, 400, ok);
    // 창은 T + 500 부터다.
    expect(layout.bursts).toEqual([expect.objectContaining({ x: -2, count: 5 })]);
  });

  it('대상으로 좁힌 타임라인도 전체 기록으로 판정해, 대상 요청이 든 구간만 그린다', () => {
    const records = [...burstAt(T), ...burstAt(T + 5000)];
    const scoped = [records[2]];
    const layout = layoutTimeline(scoped, [], T + 6000, 400, ok, records);
    expect(layout.bursts).toEqual([expect.objectContaining({ count: 5, initial: false })]);
    expect(layout.bars).toHaveLength(1);
  });

  it('쿼리만 바뀐 이동과 페이지 안 앵커는 같은 화면이라 진입이 아니다', () => {
    at(T, () => {
      history.replaceState(null, '', '/home?filter=open');
      history.pushState(null, '', '/home?page=2');
      History.prototype.replaceState.call(history, null, '', '/home?page=2#section');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(entries(burstAt(T + 500))).toEqual([false]);
  });

  it('해시 라우터(#/…, #!/…)의 경로가 바뀌면 진입이다', () => {
    // location.hash 를 바꾸면 브라우저는 주소를 바꾼 뒤 hashchange 를 보낸다. 같은 순서로 흉내 낸다.
    at(T, () => {
      History.prototype.replaceState.call(history, null, '', '/home#/users');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    at(T + 10_000, () => {
      History.prototype.replaceState.call(history, null, '', '/home#!/users?tab=2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(entries([...burstAt(T + 500), ...burstAt(T + 10_500)])).toEqual([true, false]);
  });

  it('뒤로 가기(popstate)로 화면이 바뀌면 진입이다', () => {
    at(T, () => {
      History.prototype.replaceState.call(history, null, '', '/back');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(entries(burstAt(T + 500))).toEqual([true]);
  });

  it('정적 화면으로 옮기고 한참 뒤 생긴 몰림, 이동 없이 생긴 몰림은 지금처럼 낭비다', () => {
    at(T, () => history.pushState(null, '', '/about'));
    expect(entries([...burstAt(T + 30_000), ...burstAt(T + 50_000)])).toEqual([false, false]);
  });

  it('무시·StrictMode 요청은 몰림에 세지 않는다', () => {
    const records = burstAt(T + 500);
    const classOf = (r: RequestRecord) => (r.id === records[0].id ? 'ignored' : 'ok');
    expect(analyzeBursts(records, classOf)).toEqual([]);
  });
});
