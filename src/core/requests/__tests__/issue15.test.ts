import { describe, expect, it } from 'vitest';

import { followUps } from '../followUps.js';
import type { RequestRecord } from '../types.js';

let id = 0;
const rec = (method: string, url: string, startedAt: number, extra: Partial<RequestRecord> = {}): RequestRecord =>
  ({ id: ++id, kind: 'fetch', method, url, status: 200, startedAt, durationMs: 100, body: null, ...extra }) as RequestRecord;

describe('이슈 15: 변경 요청 뒤 조회 묶기', () => {
  const save = rec('POST', '/api/save', 1000); // 응답은 1100 에 도착

  it('응답 뒤 1초 안의 GET 을 엔드포인트별로 센다', () => {
    const records = [
      save,
      rec('GET', '/api/a/1', 1150),
      rec('GET', '/api/a/2', 1200),
      rec('GET', '/api/b', 1300),
      rec('GET', '/api/late', 2200), // 창 밖
      rec('GET', '/api/early', 1050), // 응답 전
      rec('POST', '/api/other', 1200), // 조회 아님
    ];
    expect(followUps(save, records).map((f) => [f.endpoint, f.count])).toEqual([
      ['GET /api/a/:id', 2],
      ['GET /api/b', 1],
    ]);
  });

  it('queryKey 와 같은 응답 수를 담는다', () => {
    const a = rec('GET', '/api/a', 1200, { sameResponseAs: 1 });
    const [f] = followUps(save, [save, a], (r) => (r === a ? '["a"]' : undefined));
    expect(f).toMatchObject({ queryKey: '["a"]', sameResponse: 1, periodic: false });
  });

  it('periodic_excluded: 일정 간격으로 반복되는 요청은 periodic 으로 구분한다', () => {
    const polls = [0, 10_000, 20_000].map((t) => rec('GET', '/api/poll', 1200 + t));
    const [f] = followUps(save, [save, ...polls]);
    expect(f.periodic).toBe(true);
  });

  it('변경 요청이 아니면 빈 목록이다', () => {
    const get = rec('GET', '/api/x', 0);
    expect(followUps(get, [get, rec('GET', '/api/y', 150)])).toEqual([]);
  });
});
