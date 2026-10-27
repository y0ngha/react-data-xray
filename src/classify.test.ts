import { describe, expect, it } from 'vitest';

import { classifyRecords, isPeriodic, isWaste, needsReview } from './classify.js';
import type { RequestRecord } from './registry.js';

let id = 0;
const rec = (startedAt: number, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  id: ++id,
  kind: 'fetch',
  method: 'GET',
  url: '/api/x',
  status: 200,
  startedAt,
  durationMs: 10,
  body: undefined,
  ...extra,
});

describe('isPeriodic', () => {
  it('일정한 간격(10초)으로 3번 이상이면 주기 요청이다', () => {
    expect(isPeriodic([0, 10_000, 20_100, 29_900])).toBe(true);
  });

  it('간격이 들쭉날쭉하거나 1초보다 짧으면 주기 요청이 아니다', () => {
    expect(isPeriodic([0, 2_000, 9_000, 10_000])).toBe(false);
    expect(isPeriodic([0, 300, 600, 900])).toBe(false);
    expect(isPeriodic([0, 10_000])).toBe(false);
  });
});

describe('classifyRecords', () => {
  it('polling 의 같은 응답 재요청은 낭비가 아니라 주기 요청이다', () => {
    const a = rec(0);
    const b = rec(10_000, { sameResponseAs: a.id });
    const c = rec(20_000, { sameResponseAs: b.id });
    expect(classifyRecords([a, b, c], new Set()).get(c.id)).toBe('periodic');
  });

  it('앞선 요청이 취소된 중복은 StrictMode 가능성이다', () => {
    const a = rec(0, { error: 'AbortError: The user aborted a request.' });
    const b = rec(5, { duplicateOf: a.id });
    expect(classifyRecords([a, b], new Set()).get(b.id)).toBe('strict-mode');
  });

  it('취소되지 않은 중복과 같은 응답 재요청은 낭비다', () => {
    const a = rec(0);
    const b = rec(5, { duplicateOf: a.id });
    const c = rec(5_000, { url: '/api/y' });
    const d = rec(9_000, { url: '/api/y', sameResponseAs: c.id });
    const classes = classifyRecords([a, b, c, d], new Set());
    expect(classes.get(b.id)).toBe('duplicate');
    expect(classes.get(d.id)).toBe('same-response');
  });

  it('무시한 엔드포인트는 낭비로 세지 않는다', () => {
    const a = rec(0);
    const b = rec(5, { duplicateOf: a.id });
    expect(classifyRecords([a, b], new Set(['GET /api/x'])).get(b.id)).toBe('ignored');
  });

  it('포커스·재연결 직후의 재요청은 라이브러리 자동 재요청으로 본다', () => {
    const a = rec(0);
    const b = rec(60_000, { sameResponseAs: a.id, trigger: 'focus' });
    const c = rec(90_000, { sameResponseAs: b.id, trigger: 'reconnect' });
    const classes = classifyRecords([a, b, c], new Set());
    expect(classes.get(b.id)).toBe('focus-refetch');
    expect(classes.get(c.id)).toBe('reconnect-refetch');
  });

  it('React 의 StrictMode 재실행 중에 나간 중복만 StrictMode 로 본다', () => {
    const a = rec(0);
    const b = rec(3, { duplicateOf: a.id, strictModeReplay: true });
    expect(classifyRecords([a, b], new Set()).get(b.id)).toBe('strict-mode');
  });

  // 잡음 줄이기 때문에 진짜 낭비를 정상으로 오인하지 않는지
  describe('진짜 낭비는 숨기지 않는다', () => {
    it('같은 위젯 두 개가 동시에 같은 요청을 보내면(StrictMode 재실행 아님) 중복이다', () => {
      const a = rec(0, { stack: 'at useWidget (Widget.tsx:10)' });
      const b = rec(3, { stack: 'at useWidget (Widget.tsx:10)', duplicateOf: a.id });
      expect(classifyRecords([a, b], new Set()).get(b.id)).toBe('duplicate');
    });

    it('포커스 직후라도 여러 곳에서 같은 요청을 겹쳐 보내면 중복이다', () => {
      const a = rec(0, { trigger: 'focus' });
      const b = rec(5, { trigger: 'focus', duplicateOf: a.id, sameResponseAs: a.id });
      expect(classifyRecords([a, b], new Set()).get(b.id)).toBe('duplicate');
    });

    it('포커스마다 같은 응답을 다시 받는 것과 주기 요청은 정상이 아니라 확인 필요다', () => {
      const a = rec(0);
      const b = rec(60_000, { sameResponseAs: a.id, trigger: 'focus' });
      const p1 = rec(0, { url: '/api/poll' });
      const p2 = rec(5_000, { url: '/api/poll', sameResponseAs: p1.id });
      const p3 = rec(10_000, { url: '/api/poll', sameResponseAs: p2.id });
      const classes = classifyRecords([a, b, p1, p2, p3], new Set());
      expect(needsReview(classes.get(b.id))).toBe(true);
      expect(needsReview(classes.get(p3.id))).toBe(true);
      expect(isWaste(classes.get(p3.id))).toBe(false);
    });

    it('간격이 불규칙한 반복(interval 누수 등)은 주기 요청이 아니라 같은 응답 재요청이다', () => {
      const a = rec(0);
      const b = rec(1_200, { sameResponseAs: a.id });
      const c = rec(4_000, { sameResponseAs: b.id });
      const d = rec(4_900, { sameResponseAs: c.id });
      expect(classifyRecords([a, b, c, d], new Set()).get(d.id)).toBe('same-response');
    });
  });
});
