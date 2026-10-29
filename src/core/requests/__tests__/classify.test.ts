import { describe, expect, it } from 'vitest';

import { classifyRecords, classLabel, isPeriodic, isWaste, needsReview } from '../classify.js';
import type { RequestRecord } from '../types.js';

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

  it('간격이 들쭉날쭉하거나, 1초보다 짧거나, 2번뿐이면 주기 요청이 아니다', () => {
    expect(isPeriodic([0, 2_000, 9_000, 10_000])).toBe(false);
    expect(isPeriodic([0, 300, 600, 900])).toBe(false);
    expect(isPeriodic([0, 10_000])).toBe(false);
  });
});

describe('classifyRecords', () => {
  it('표시가 없는 요청은 ok 다', () => {
    const a = rec(0);
    expect(classifyRecords([a], new Set()).get(a.id)).toBe('ok');
  });

  it('polling 의 같은 응답 재요청은 낭비가 아니라 주기 요청(확인 필요)이다', () => {
    const a = rec(0);
    const b = rec(10_000, { sameResponseAs: a.id });
    const c = rec(20_000, { sameResponseAs: b.id });
    const classes = classifyRecords([a, b, c], new Set());
    expect(classes.get(c.id)).toBe('periodic');
    expect(needsReview(classes.get(c.id))).toBe(true);
    expect(isWaste(classes.get(c.id))).toBe(false);
  });

  it('앞선 요청이 취소됐거나 StrictMode 재실행 중이면 StrictMode 로 본다', () => {
    const a = rec(0, { error: 'AbortError: aborted' });
    const b = rec(5, { duplicateOf: a.id });
    const c = rec(50_000, { url: '/api/z' });
    const d = rec(50_003, { url: '/api/z', duplicateOf: c.id, strictModeReplay: true });
    const classes = classifyRecords([a, b, c, d], new Set());
    expect(classes.get(b.id)).toBe('strict-mode');
    expect(classes.get(d.id)).toBe('strict-mode');
  });

  it('포커스·재연결 직후의 같은 응답 재요청은 자동 재요청으로 본다', () => {
    const a = rec(0);
    const b = rec(60_000, { sameResponseAs: a.id, trigger: 'focus' });
    const c = rec(90_000, { sameResponseAs: b.id, trigger: 'reconnect' });
    const classes = classifyRecords([a, b, c], new Set());
    expect(classes.get(b.id)).toBe('focus-refetch');
    expect(classes.get(c.id)).toBe('reconnect-refetch');
  });

  it('무시한 엔드포인트는 낭비로 세지 않는다', () => {
    const a = rec(0);
    const b = rec(5, { duplicateOf: a.id });
    expect(classifyRecords([a, b], new Set(['GET /api/x'])).get(b.id)).toBe('ignored');
  });

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

    it('간격이 불규칙한 반복(interval 누수 등)은 같은 응답 재요청이다', () => {
      const a = rec(0);
      const b = rec(1_200, { sameResponseAs: a.id });
      const c = rec(4_000, { sameResponseAs: b.id });
      const d = rec(4_900, { sameResponseAs: c.id });
      expect(classifyRecords([a, b, c, d], new Set()).get(d.id)).toBe('same-response');
    });

    it('payload 를 읽을 수 없는 요청은 주기 판정에 넣지 않는다', () => {
      const list = [0, 10_000, 20_000].map((t, i) =>
        rec(t, { url: '/api/blob', bodyUnreadable: true, sameResponseAs: i > 0 ? 1 : undefined }),
      );
      expect(classifyRecords(list, new Set()).get(list[2].id)).toBe('same-response');
    });
  });

  it('Server Action polling 은 action 별로 주기 요청으로 나누고, 같은 주소의 다른 action 과 섞지 않는다', () => {
    const poll = (t: number) =>
      rec(t, { method: 'POST', url: '/MSFT/news', requestBody: '["MSFT"]', action: '40828a5a92cb004a18', sameResponseAs: 1 });
    const polls = [0, 3_000, 6_000, 9_000].map(poll);
    const other = rec(7_000, { method: 'POST', url: '/MSFT/news', requestBody: '["MSFT"]', action: '601f13b65c219414' });
    const classes = classifyRecords([...polls, other], new Set());
    expect(polls.slice(1).map((r) => classes.get(r.id))).toEqual(['periodic', 'periodic', 'periodic']);
    expect(classes.get(other.id)).toBe('ok');
  });
});

describe('classLabel', () => {
  it('기본값(en)은 영어 라벨을 돌려준다', () => {
    expect(classLabel('duplicate')).toBe('duplicate request');
    expect(classLabel('periodic')).toBe('polling');
  });

  it('ko 는 한국어 라벨을 돌려준다', () => {
    expect(classLabel('duplicate', 'ko')).toBe('중복 요청');
    expect(classLabel('same-response', 'ko')).toBe('같은 응답 재요청');
    expect(classLabel('periodic', 'ko')).toBe('주기 요청');
    expect(classLabel('focus-refetch', 'ko')).toBe('포커스 재요청');
  });
});
