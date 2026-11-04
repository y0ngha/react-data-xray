import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { layoutTimeline } from '../../../ui/panels/timeline/timelineLayout.js';
import { classifyBursts } from '../bursts.js';
import type { RequestRecord } from '../types.js';

// #82: 페이지 로드 3초 뒤 SPA 화면을 옮기면 새 화면의 진입 몰림이 낭비로 잡혔다.
// setup.ts 가 설치한 가로채기(`installCapture`)로 history 가 이미 감싸져 있다.
const ok = () => 'ok' as const;
let nextId = 1;

const req = (startedAt: number): RequestRecord =>
  ({
    id: nextId++,
    kind: 'fetch',
    method: 'GET',
    url: `/api/${nextId}`,
    status: 200,
    startedAt,
    durationMs: 10,
    body: null,
  }) as RequestRecord;

/** at 부터 100ms 간격으로 5건(몰림) */
const burstAt = (at: number): RequestRecord[] => [0, 100, 200, 300, 400].map((d) => req(at + d));

const entries = (records: RequestRecord[]): boolean[] => classifyBursts(records, ok).map((b) => b.entry);

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

  it('주소를 바꾸기 전에 데이터를 받는 라우터(loader, RSC)의 몰림은 1초 앞까지 진입이다', () => {
    at(T + 800, () => history.pushState(null, '', '/orders'));
    expect(entries(burstAt(T))).toEqual([true]);
    // 이동보다 1초 넘게 앞선 몰림은 낭비로 남는다.
    at(T + 20_000 + 1500, () => history.pushState(null, '', '/users'));
    expect(entries(burstAt(T + 20_000))).toEqual([false]);
  });

  it('이동에 걸친 몰림은 몰림 단위로 판정해 통째로 진입이고, 타임라인도 같다', () => {
    at(T + 150, () => history.pushState(null, '', '/orders'));
    const records = [req(T), req(T + 100), ...burstAt(T + 200)];
    expect(classifyBursts(records, ok)).toEqual([expect.objectContaining({ from: T, to: T + 600, count: 7, entry: true })]);
    expect(layoutTimeline(records, [], T + 1000, 400, ok).bursts.map((b) => b.initial)).toEqual([true]);
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
    expect(classifyBursts(records, classOf)).toEqual([]);
  });
});
